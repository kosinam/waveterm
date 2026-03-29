// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockModel } from "@/app/block/block-model";
import { atoms } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { globalStore } from "./jotaiStore";
import { waveEventSubscribeSingle } from "./wps";

// Sorted list of all agent notifications, newest first.
export const agentNotificationsAtom: PrimitiveAtom<AgentNotification[]> = atom([] as AgentNotification[]);

const readIdsStorageKey = "agentNotifyReadIds";

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
}

// Flash the originating block's border (double-flash) if it is visible in the current tab.
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

export function setupAgentNotifySubscription(): void {
    // Sync read IDs across renderers: when another renderer marks a notification as read,
    // this renderer gets a storage event and updates its atom immediately.
    window.addEventListener("storage", (event) => {
        if (event.key === readIdsStorageKey) {
            const newIds = event.newValue ? new Set<string>(JSON.parse(event.newValue)) : new Set<string>();
            globalStore.set(agentReadIdsAtom, newIds);
        }
    });

    waveEventSubscribeSingle({
        eventType: "agent:notify",
        handler: (event) => {
            const data = event.data as AgentNotifyEvent;
            if (data == null) return;

            if (data.clearall) {
                globalStore.set(agentNotificationsAtom, []);
                globalStore.set(agentReadIdsAtom, new Set<string>());
                saveReadIdsToStorage(new Set<string>());
                return;
            }
            if (data.clear && data.notifyid) {
                globalStore.set(agentNotificationsAtom, (prev) =>
                    prev.filter((n) => n.notifyid !== data.notifyid)
                );
                return;
            }
            if (data.notification == null) return;

            const incoming = data.notification;
            globalStore.set(agentNotificationsAtom, (prev) => {
                // Replace if same notifyid (updated status), otherwise prepend
                const existing = prev.findIndex((n) => n.notifyid === incoming.notifyid);
                if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = incoming;
                    // Clear read state so the updated notification shows as unread
                    globalStore.set(agentReadIdsAtom, (readPrev) => {
                        if (!readPrev.has(incoming.notifyid)) return readPrev;
                        const nextRead = new Set(readPrev);
                        nextRead.delete(incoming.notifyid);
                        saveReadIdsToStorage(nextRead);
                        return nextRead;
                    });
                    return next;
                }
                return [incoming, ...prev];
            });
            flashBlockIfVisible(incoming);
        },
    });
}

export async function loadAgentNotifications(): Promise<void> {
    try {
        const notifications = await RpcApi.GetAllAgentNotificationsCommand(TabRpcClient);
        if (notifications == null) return;
        // Sort newest first by timestamp
        const sorted = [...notifications].sort((a, b) => b.timestamp - a.timestamp);
        globalStore.set(agentNotificationsAtom, sorted);
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
