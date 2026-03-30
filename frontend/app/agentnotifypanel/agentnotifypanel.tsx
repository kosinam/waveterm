// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { agentNotificationsAtom, agentReadIdsAtom, clearAllAgentNotifications, markAgentNotificationRead } from "@/app/store/agentnotify";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback } from "react";
import { AgentNotifyItem } from "./agentnotifyitem";

type NavigateToNotificationOpts = {
    markRead?: boolean;
};

function getStatusIcon(status: string): { icon: string; color: string } {
    switch (status) {
        case "completion":
            return { icon: "fa-check-circle", color: "#4ade80" };
        case "question":
            return { icon: "fa-question-circle", color: "#fbbf24" };
        case "waiting":
            return { icon: "fa-clock", color: "#60a5fa" };
        case "error":
            return { icon: "fa-times-circle", color: "#ef4444" };
        default:
            return { icon: "fa-info-circle", color: "#94a3b8" };
    }
}

async function navigateToNotification(notification: AgentNotification, opts?: NavigateToNotificationOpts) {
    if (!notification) return;
    if (opts?.markRead ?? true) {
        markAgentNotificationRead(notification.notifyid);
    }

    const blockId = notification.oref ? notification.oref.split(":")[1] : null;

    // Switch workspace if the notification came from a different one
    const currentWorkspaceId = globalStore.get(atoms.workspaceId);
    if (notification.workspaceid && notification.workspaceid !== currentWorkspaceId) {
        // Store the pending flash in localStorage so the new renderer picks it up after init.
        // We can't send SetBlockFocusCommand from this renderer because it will be destroyed
        // during the workspace switch before the command can be delivered.
        if (blockId && notification.tabid) {
            localStorage.setItem(
                "pendingBlockFlash",
                JSON.stringify({ blockId, tabId: notification.tabid })
            );
        }
        getApi().switchWorkspace(notification.workspaceid);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Switch to the target tab
    if (notification.tabid) {
        getApi().setActiveTab(notification.tabid);
    }

    // Same-workspace flash: the target renderer is already running so RPC routing works.
    // For cross-workspace we use localStorage instead (see above) because this renderer
    // will be destroyed by the time the new tab renderer is ready.
    const isSameWorkspace = !notification.workspaceid || notification.workspaceid === currentWorkspaceId;
    if (blockId && isSameWorkspace) {
        setTimeout(() => {
            fireAndForget(() =>
                RpcApi.SetBlockFocusCommand(TabRpcClient, blockId, {
                    route: notification.tabid ? `tab:${notification.tabid}` : undefined,
                })
            );
        }, 50);
    }
}

function getApi(): ElectronApi {
    return (window as any).api;
}

export const AgentNotifyPanel = memo(() => {
    const notifications = useAtomValue(agentNotificationsAtom);
    const readIds = useAtomValue(agentReadIdsAtom);

    const handleNavigate = useCallback((n: AgentNotification) => {
        fireAndForget(() => navigateToNotification(n, { markRead: true }));
    }, []);

    const handleClearAll = useCallback(() => {
        clearAllAgentNotifications();
    }, []);

    return (
        <div
            className="flex h-full flex-col overflow-hidden select-none"
            style={{ background: "rgba(0, 0, 0, 0.25)" }}
        >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between px-2 py-1.5 border-b border-border/30">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-secondary/70">Agents</span>
                {notifications.length > 0 && (
                    <button
                        className="text-[11px] text-secondary/50 hover:text-secondary transition-colors cursor-pointer"
                        onClick={handleClearAll}
                        title="Clear all notifications"
                    >
                        Clear all
                    </button>
                )}
            </div>

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {notifications.length === 0 ? (
                    <div className="flex items-center justify-center h-full px-3">
                        <span className="text-[11px] text-secondary/30 text-center">
                            No agent notifications.
                            <br />
                            Use <code className="text-secondary/50">wsh agentnotify</code> to send one.
                        </span>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1 p-1">
                        {notifications.map((n) => (
                            <AgentNotifyItem
                                key={n.notifyid}
                                notification={n}
                                isRead={readIds.has(n.notifyid)}
                                onNavigate={handleNavigate}
                                getStatusIcon={getStatusIcon}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

AgentNotifyPanel.displayName = "AgentNotifyPanel";

export { getStatusIcon, navigateToNotification };
