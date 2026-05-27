// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockModel } from "@/app/block/block-model";
import { atoms, WOS } from "@/app/store/global";
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
const defaultShellPruneAgeMs = 60 * 1000;
const shellPruneCheckIntervalMs = 30 * 1000;
const shellPruneAgeKey: keyof SettingsType = "agent:clearreadafterms";
const pendingPruneIds = new Set<string>();
const unreadStatuses = new Set(["completion", "question", "waiting", "error"]);

let shellPruneInterval: number | null = null;

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

function hasSameActionableContent(a: AgentNotification, b: AgentNotification): boolean {
    return (
        a.notifyid === b.notifyid &&
        (a.status ?? "") === (b.status ?? "") &&
        (a.message ?? "") === (b.message ?? "")
    );
}

export function shouldResetReadState(existing: AgentNotification | null | undefined, incoming: AgentNotification): boolean {
    if (existing == null) {
        return true;
    }
    if (!unreadStatuses.has(incoming.status ?? "")) {
        return false;
    }
    // Only suppress re-notification if it's the exact same event (same content AND same timestamp).
    // A different timestamp means a new hook invocation — even with identical message text, the
    // agent is asking again and the user needs to see the badge.
    if (hasSameActionableContent(existing, incoming) && existing.timestamp === incoming.timestamp) {
        return false;
    }
    return true;
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

// Tracks when each notification last arrived so we can apply a grace period before
// auto-marking it as read on keystroke (prevents notifications from being immediately
// dismissed when the user is already typing in the originating block).
const notificationArrivalMs = new Map<string, number>();
const notificationKeystrokeGraceMs = 3000;

// Set of notifyids that have been read (navigated to), persisted across workspace switches.
export const agentReadIdsAtom: PrimitiveAtom<Set<string>> = atom(loadReadIdsFromStorage());

// Map of notifyid → latest intermediate notification (agent is actively working).
// Cleared when the terminal notification arrives for that notifyid.
export const agentInProgressAtom: PrimitiveAtom<Map<string, AgentNotification>> = atom(
    new Map<string, AgentNotification>()
);

// Tracks when in-progress first started for each notifyid (ms since epoch).
// Module-level so it persists across re-renders without triggering atom updates.
const inProgressStartMs = new Map<string, number>();

export function getInProgressStartMs(notifyId: string): number {
    return inProgressStartMs.get(notifyId) ?? Date.now();
}

// Two-stage idle handling for the in-progress spinner:
//   Stage 1 (30s): relabel the message to "Working" so deep-thinking pauses
//     between tool calls still look alive.
//   Stage 2 (60s): assume the agent was interrupted (Ctrl-C / Esc fires no
//     terminal hook) and clear the indicator entirely.
const inProgressWorkingTimeoutMs = 30000;
const inProgressIdleTimeoutMs = 60000;
const inProgressWorkingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const inProgressClearTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleInProgressIdleTimeout(notifyId: string) {
    cancelInProgressIdleTimeout(notifyId);
    const workingId = setTimeout(() => {
        inProgressWorkingTimeouts.delete(notifyId);
        globalStore.set(agentInProgressAtom, (prev) => {
            const current = prev.get(notifyId);
            if (!current) return prev;
            const next = new Map(prev);
            next.set(notifyId, { ...current, message: "Working..." });
            return next;
        });
    }, inProgressWorkingTimeoutMs);
    inProgressWorkingTimeouts.set(notifyId, workingId);
    const clearId = setTimeout(() => {
        inProgressClearTimeouts.delete(notifyId);
        inProgressStartMs.delete(notifyId);
        globalStore.set(agentInProgressAtom, (prev) => {
            if (!prev.has(notifyId)) return prev;
            const next = new Map(prev);
            next.delete(notifyId);
            return next;
        });
    }, inProgressIdleTimeoutMs);
    inProgressClearTimeouts.set(notifyId, clearId);
}

function cancelInProgressIdleTimeout(notifyId: string) {
    const working = inProgressWorkingTimeouts.get(notifyId);
    if (working) {
        clearTimeout(working);
        inProgressWorkingTimeouts.delete(notifyId);
    }
    const clear = inProgressClearTimeouts.get(notifyId);
    if (clear) {
        clearTimeout(clear);
        inProgressClearTimeouts.delete(notifyId);
    }
}

// Derived count of unread notifications.
export const agentUnreadCountAtom = atom((get) => {
    const notifications = get(agentNotificationsAtom);
    const readIds = get(agentReadIdsAtom);
    return notifications.filter((n) => !readIds.has(n.notifyid) && n.lifecycle !== "intermediate").length;
});

// Derived list of notifications sorted by tab position (left-to-right in the tab bar),
// then by pane position within a tab, then by timestamp.
export const sortedAgentNotificationsAtom = atom((get) => {
    const notifications = get(agentNotificationsAtom);
    const workspace = get(atoms.workspace);
    const tabIds: string[] = workspace?.tabids ?? [];

    const tabIndexMap = new Map<string, number>();
    tabIds.forEach((tabId, i) => tabIndexMap.set(tabId, i));

    const blockPositionMap = new Map<string, number>();
    for (const tabId of tabIds) {
        const tab = WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabId), get);
        if (!tab?.layoutstate) continue;
        const layoutState = WOS.getObjectValue<LayoutState>(WOS.makeORef("layout", tab.layoutstate), get);
        if (!layoutState?.leaforder) continue;
        layoutState.leaforder.forEach((entry, i) => blockPositionMap.set(entry.blockid, i));
    }

    return [...notifications].sort((a, b) => {
        const tabA = tabIndexMap.get(a.tabid) ?? Number.MAX_SAFE_INTEGER;
        const tabB = tabIndexMap.get(b.tabid) ?? Number.MAX_SAFE_INTEGER;
        if (tabA !== tabB) return tabA - tabB;

        const blockIdA = a.oref?.split(":")[1];
        const blockIdB = b.oref?.split(":")[1];
        const blockA = blockIdA != null ? (blockPositionMap.get(blockIdA) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
        const blockB = blockIdB != null ? (blockPositionMap.get(blockIdB) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
        if (blockA !== blockB) return blockA - blockB;

        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        return a.notifyid.localeCompare(b.notifyid);
    });
});

function getShellPruneAgeMs(): number {
    let configuredValue: unknown;
    try {
        configuredValue = globalStore.get(atoms.settingsAtom)?.[shellPruneAgeKey];
    } catch {
        return defaultShellPruneAgeMs;
    }
    if (typeof configuredValue !== "number" || !Number.isFinite(configuredValue)) {
        return defaultShellPruneAgeMs;
    }
    return configuredValue;
}

function pruneReadShellNotifications(): void {
    const pruneAgeMs = getShellPruneAgeMs();
    if (pruneAgeMs < 0) return;

    const now = Date.now();
    const notifications = globalStore.get(agentNotificationsAtom);
    const readIds = globalStore.get(agentReadIdsAtom);
    for (const notification of notifications) {
        if (notification.agent !== "shell") continue;
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

export function markAgentNotificationRead(notifyId: string): void {
    globalStore.set(agentReadIdsAtom, (prev) => {
        if (prev.has(notifyId)) return prev;
        const next = new Set(prev);
        next.add(notifyId);
        saveReadIdsToStorage(next);
        return next;
    });
    pruneReadShellNotifications();
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
    return event.key === "Enter" || event.key === "Backspace" || event.key === "Delete" || event.key === "Tab";
}

function markUnreadNotificationsReadForBlock(target: EventTarget | null): void {
    const targetBlockId = getEventBlockId(target);
    if (!targetBlockId) return;
    markUnreadNotificationsReadForBlockId(targetBlockId);
}

export function markUnreadNotificationsReadForBlockId(
    targetBlockId: string,
    opts?: { ignoreGracePeriod?: boolean }
): void {
    if (!targetBlockId) return;
    const now = Date.now();
    const notifications = globalStore.get(agentNotificationsAtom);
    const readIds = globalStore.get(agentReadIdsAtom);
    for (const notification of notifications) {
        if (readIds.has(notification.notifyid)) continue;
        const notificationBlockId = notification.oref?.split(":")[1];
        if (notificationBlockId !== targetBlockId) continue;
        const arrivedAt = notificationArrivalMs.get(notification.notifyid) ?? 0;
        if (!opts?.ignoreGracePeriod && now - arrivedAt < notificationKeystrokeGraceMs) continue;
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
            setTimeout(() => {
                bm.setBlockHighlight(null);
                setTimeout(() => {
                    bm.setBlockHighlight({ blockId, borderOnly: true });
                    setTimeout(() => bm.setBlockHighlight(null), 220);
                }, 110);
            }, 220);
        }, 110);
    }, 220);
}

export function setupAgentNotifySubscription(): void {
    if (shellPruneInterval == null) {
        pruneReadShellNotifications();
        shellPruneInterval = window.setInterval(pruneReadShellNotifications, shellPruneCheckIntervalMs);
    }

    const refreshReadIdsFromStorage = () => {
        globalStore.set(agentReadIdsAtom, loadReadIdsFromStorage());
        pruneReadShellNotifications();
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
        eventType: "blockclose",
        handler: (event) => {
            const blockId = event.data as string;
            if (!blockId) return;
            const oref = `block:${blockId}`;
            const notifications = globalStore.get(agentNotificationsAtom);
            for (const notification of notifications) {
                if (notification.oref === oref) {
                    clearAgentNotification(notification.notifyid);
                }
            }
        },
    });

    waveEventSubscribeSingle({
        eventType: "agent:notify",
        handler: (event) => {
            const data = event.data as AgentNotifyEvent;
            if (data == null) return;

            if (data.clearall) {
                inProgressWorkingTimeouts.forEach((id) => clearTimeout(id));
                inProgressWorkingTimeouts.clear();
                inProgressClearTimeouts.forEach((id) => clearTimeout(id));
                inProgressClearTimeouts.clear();
                inProgressStartMs.clear();
                pendingPruneIds.clear();
                globalStore.set(agentNotificationsAtom, []);
                globalStore.set(agentInProgressAtom, new Map());
                globalStore.set(agentReadIdsAtom, new Set<string>());
                saveReadIdsToStorage(new Set<string>());
                return;
            }
            if (data.clear && data.notifyid) {
                cancelInProgressIdleTimeout(data.notifyid);
                inProgressStartMs.delete(data.notifyid);
                pendingPruneIds.delete(data.notifyid);
                globalStore.set(agentNotificationsAtom, (prev) => prev.filter((n) => n.notifyid !== data.notifyid));
                globalStore.set(agentInProgressAtom, (prev) => {
                    if (!prev.has(data.notifyid!)) return prev;
                    const next = new Map(prev);
                    next.delete(data.notifyid!);
                    return next;
                });
                clearAgentNotificationReadState(data.notifyid);
                notificationArrivalMs.delete(data.notifyid);
                return;
            }
            if (data.notification == null) return;

            const incoming = data.notification;
            notificationArrivalMs.set(incoming.notifyid, Date.now());

            if (incoming.lifecycle === "intermediate") {
                // Record start time only on the first intermediate for this notifyid.
                if (!inProgressStartMs.has(incoming.notifyid)) {
                    inProgressStartMs.set(incoming.notifyid, Date.now());
                }
                // Update the in-progress indicator without touching the terminal notification or read state.
                globalStore.set(agentInProgressAtom, (prev) => {
                    const next = new Map(prev);
                    next.set(incoming.notifyid, incoming);
                    return next;
                });
                scheduleInProgressIdleTimeout(incoming.notifyid);
                // If no terminal notification exists yet, add a placeholder so the panel
                // renders an item that can show the in-progress indicator.
                const hasTerminal = globalStore.get(agentNotificationsAtom).some(
                    (n) => n.notifyid === incoming.notifyid
                );
                if (!hasTerminal) {
                    globalStore.set(agentNotificationsAtom, (prev) =>
                        sortAgentNotifications([...prev, incoming])
                    );
                }
                return;
            }

            // Terminal notification: clear any in-progress indicator for this notifyid.
            cancelInProgressIdleTimeout(incoming.notifyid);
            inProgressStartMs.delete(incoming.notifyid);
            globalStore.set(agentInProgressAtom, (prev) => {
                if (!prev.has(incoming.notifyid)) return prev;
                const next = new Map(prev);
                next.delete(incoming.notifyid);
                return next;
            });

            const existing = globalStore.get(agentNotificationsAtom).find((n) => n.notifyid === incoming.notifyid);
            if (shouldResetReadState(existing, incoming)) {
                clearAgentNotificationReadState(incoming.notifyid);
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
            pruneReadShellNotifications();
        },
    });
}

export async function loadAgentNotifications(): Promise<void> {
    try {
        const notifications = await RpcApi.GetAllAgentNotificationsCommand(TabRpcClient);
        if (notifications == null) return;
        globalStore.set(agentNotificationsAtom, sortAgentNotifications(notifications));
        pruneReadShellNotifications();
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
