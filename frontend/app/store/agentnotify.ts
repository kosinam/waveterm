// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockModel } from "@/app/block/block-model";
import { atoms } from "@/app/store/global-atoms";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { globalStore } from "./jotaiStore";
import { waveEventSubscribeSingle } from "./wps";

// Sorted list of all agent notifications, oldest first.
export const agentNotificationsAtom: PrimitiveAtom<AgentNotification[]> = atom([] as AgentNotification[]);

const readIdsStorageKey = "agentNotifyReadIds";
const defaultAgentReadPruneAgeMs = 5 * 60 * 1000;
const agentReadPruneCheckIntervalMs = 60 * 1000;
const agentReadPruneAgeKey: keyof SettingsType = "agent:clearreadafterms";
const pendingPruneIds = new Set<string>();

let agentReadPruneInterval: number | null = null;

function areAgentNotificationsEqual(a: AgentNotification, b: AgentNotification): boolean {
    return (
        a.notifyid === b.notifyid &&
        a.oref === b.oref &&
        a.tabid === b.tabid &&
        a.workspaceid === b.workspaceid &&
        a.windowid === b.windowid &&
        a.agent === b.agent &&
        a.status === b.status &&
        a.message === b.message &&
        a.workdir === b.workdir &&
        a.branch === b.branch &&
        a.worktree === b.worktree &&
        a.timestamp === b.timestamp &&
        a.workspacename === b.workspacename
    );
}

function sortAgentNotifications(notifications: AgentNotification[]): AgentNotification[] {
    return [...notifications].sort((a, b) => {
        if (a.timestamp !== b.timestamp) {
            return a.timestamp - b.timestamp;
        }
        return a.notifyid.localeCompare(b.notifyid);
    });
}

function loadReadIdsFromStorage(): Set<string> {
    try {
        const raw = localStorage.getItem(readIdsStorageKey);
        if (raw) return new Set(JSON.parse(raw));
    } catch {
        // ignore
    }
    return new Set<string>();
}

function saveReadIdsToStorage(ids: Set<string>) {
    try {
        localStorage.setItem(readIdsStorageKey, JSON.stringify([...ids]));
    } catch {
        // ignore
    }
}

// Set of notifyids that have been read (navigated to), persisted across workspace switches.
export const agentReadIdsAtom: PrimitiveAtom<Set<string>> = atom(loadReadIdsFromStorage());

// Derived count of unread notifications.
export const agentUnreadCountAtom = atom((get) => {
    const notifications = get(agentNotificationsAtom);
    const readIds = get(agentReadIdsAtom);
    return notifications.filter((n) => !readIds.has(n.notifyid)).length;
});

export function markAgentNotificationRead(notifyId: string): void {
    globalStore.set(agentReadIdsAtom, (prev) => {
        if (prev.has(notifyId)) return prev;
        const next = new Set(prev);
        next.add(notifyId);
        saveReadIdsToStorage(next);
        return next;
    });
    pruneReadAgentNotifications();
}

function clearAgentNotificationReadState(notifyId: string): void {
    globalStore.set(agentReadIdsAtom, (prev) => {
        if (!prev.has(notifyId)) return prev;
        const next = new Set(prev);
        next.delete(notifyId);
        saveReadIdsToStorage(next);
        return next;
    });
}

function getEventBlockId(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>("[data-blockid]")?.dataset.blockid ?? null;
}

function isMeaningfulTypingKey(event: KeyboardEvent): boolean {
    if ((window as any).__waveActiveChord) return false;
    if (event.defaultPrevented || event.isComposing) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key.length === 1) return true;
    return event.key === "Enter" || event.key === "Backspace" || event.key === "Delete";
}

function markUnreadNotificationsReadForBlock(target: EventTarget | null): void {
    const targetBlockId = getEventBlockId(target);
    if (!targetBlockId) return;
    const notifications = globalStore.get(agentNotificationsAtom);
    const readIds = globalStore.get(agentReadIdsAtom);
    for (const notification of notifications) {
        if (readIds.has(notification.notifyid)) continue;
        const notificationBlockId = notification.oref?.split(":")[1];
        if (notificationBlockId !== targetBlockId) continue;
        markAgentNotificationRead(notification.notifyid);
    }
}

// Flash the originating block's border (triple-flash) if it is visible in the current tab.
function flashBlockIfVisible(notification: AgentNotification): void {
    if (!notification.oref) return;
    const blockId = notification.oref.split(":")[1];
    if (!blockId) return;
    const currentWorkspaceId = globalStore.get(atoms.workspaceId);
    if (notification.workspaceid && notification.workspaceid !== currentWorkspaceId) return;
    const layoutModel = getLayoutModelForStaticTab();
    if (!layoutModel) return;
    const node = layoutModel.getNodeByBlockId(blockId);
    if (!node) return;
    const bm = BlockModel.getInstance();
    bm.setBlockHighlight({ blockId, borderOnly: true });
    setTimeout(() => {
        bm.setBlockHighlight(null);
        setTimeout(() => {
            bm.setBlockHighlight({ blockId, borderOnly: true });
            setTimeout(() => bm.setBlockHighlight(null), 300);
        }, 150);
    }, 300);
}

function getAgentReadPruneAgeMs(): number {
    const configuredValue = globalStore.get(atoms.settingsAtom)?.[agentReadPruneAgeKey];
    if (typeof configuredValue !== "number" || !Number.isFinite(configuredValue)) {
        return defaultAgentReadPruneAgeMs;
    }
    return configuredValue;
}

function pruneReadAgentNotifications(): void {
    const pruneAgeMs = getAgentReadPruneAgeMs();
    if (pruneAgeMs < 0) return;

    const now = Date.now();
    const notifications = globalStore.get(agentNotificationsAtom);
    const readIds = globalStore.get(agentReadIdsAtom);
    for (const notification of notifications) {
        if (!readIds.has(notification.notifyid)) continue;
        if (!(notification.timestamp > 0)) continue;
        if (now - notification.timestamp < pruneAgeMs) continue;
        if (pendingPruneIds.has(notification.notifyid)) continue;

        pendingPruneIds.add(notification.notifyid);
        fireAndForget(async () => {
            try {
                await RpcApi.ClearAgentNotificationCommand(TabRpcClient, notification.notifyid);
            } finally {
                pendingPruneIds.delete(notification.notifyid);
            }
        });
    }
}

export function setupAgentNotifySubscription(): void {
    if (agentReadPruneInterval == null) {
        pruneReadAgentNotifications();
        agentReadPruneInterval = window.setInterval(pruneReadAgentNotifications, agentReadPruneCheckIntervalMs);
    }

    const refreshReadIdsFromStorage = () => {
        globalStore.set(agentReadIdsAtom, loadReadIdsFromStorage());
        pruneReadAgentNotifications();
    };

    // Sync read IDs across renderers: when another renderer marks a notification as read,
    // this renderer gets a storage event and updates its atom immediately.
    window.addEventListener("storage", (event) => {
        if (event.key === readIdsStorageKey) {
            refreshReadIdsFromStorage();
        }
    });
    window.addEventListener("focus", refreshReadIdsFromStorage);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            refreshReadIdsFromStorage();
        }
    });

    document.addEventListener(
        "keydown",
        (event) => {
            if (!isMeaningfulTypingKey(event)) return;
            markUnreadNotificationsReadForBlock(event.target);
        },
        true
    );
    document.addEventListener(
        "beforeinput",
        (event) => {
            markUnreadNotificationsReadForBlock(event.target);
        },
        true
    );
    document.addEventListener(
        "paste",
        (event) => {
            markUnreadNotificationsReadForBlock(event.target);
        },
        true
    );

    waveEventSubscribeSingle({
        eventType: "agent:notify",
        handler: (event) => {
            const data = event.data as AgentNotifyEvent;
            if (data == null) return;

            if (data.clearall) {
                globalStore.set(agentNotificationsAtom, []);
                globalStore.set(agentReadIdsAtom, new Set<string>());
                saveReadIdsToStorage(new Set<string>());
                pendingPruneIds.clear();
                return;
            }
            if (data.clear && data.notifyid) {
                globalStore.set(agentNotificationsAtom, (prev) => prev.filter((n) => n.notifyid !== data.notifyid));
                clearAgentNotificationReadState(data.notifyid);
                pendingPruneIds.delete(data.notifyid);
                return;
            }
            if (data.notification == null) return;

            const incoming = data.notification;
            const existing = globalStore.get(agentNotificationsAtom).find((n) => n.notifyid === incoming.notifyid);
            if (existing == null) {
                clearAgentNotificationReadState(incoming.notifyid);
            } else if (!areAgentNotificationsEqual(existing, incoming)) {
                // Only re-mark unread when the new status requires user attention.
                // Transitions to completion/info should not re-alert (e.g. stop hook
                // firing after user already responded to a question).
                const attentionStatuses = new Set(["question", "waiting", "error"]);
                if (attentionStatuses.has(incoming.status ?? "")) {
                    clearAgentNotificationReadState(incoming.notifyid);
                }
            }
            globalStore.set(agentNotificationsAtom, (prev) => {
                // Replace if same notifyid (updated status), otherwise insert and keep oldest-first order
                const existing = prev.findIndex((n) => n.notifyid === incoming.notifyid);
                if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = incoming;
                    return sortAgentNotifications(next);
                }
                return sortAgentNotifications([...prev, incoming]);
            });
            flashBlockIfVisible(incoming);
            pruneReadAgentNotifications();
        },
    });
}

export async function loadAgentNotifications(): Promise<void> {
    try {
        const notifications = await RpcApi.GetAllAgentNotificationsCommand(TabRpcClient);
        if (notifications == null) return;
        globalStore.set(agentNotificationsAtom, sortAgentNotifications(notifications));
        pruneReadAgentNotifications();
    } catch (_) {
        // Non-fatal — panel will be empty on load failure
    }
}

export function clearAgentNotification(notifyId: string): void {
    fireAndForget(() => RpcApi.ClearAgentNotificationCommand(TabRpcClient, notifyId));
}

export function clearAllAgentNotifications(): void {
    fireAndForget(() => RpcApi.ClearAllAgentNotificationsCommand(TabRpcClient));
}

export function reloadReadIds(): void {
    globalStore.set(agentReadIdsAtom, loadReadIdsFromStorage());
}
