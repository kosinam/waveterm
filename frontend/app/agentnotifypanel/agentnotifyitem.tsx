// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { clearAgentNotification } from "@/app/store/agentnotify";
import { cn } from "@/util/util";
import { memo, useCallback } from "react";

function formatTime(timestampMs: number): string {
    if (!timestampMs) return "";
    const d = new Date(timestampMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}


function shortenPath(path: string): string {
    if (!path) return "";
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return "…/" + parts.slice(-1)[0];
}

function shortenBranch(branch: string): string {
    if (!branch) return "";
    if (branch.length <= 24) return branch;
    return branch.substring(0, 22) + "…";
}

interface AgentNotifyItemProps {
    notification: AgentNotification;
    isRead: boolean;
    onNavigate: (n: AgentNotification) => void;
    getStatusIcon: (status: string) => { icon: string; color: string };
}


export const AgentNotifyItem = memo(({ notification, isRead, onNavigate, getStatusIcon }: AgentNotifyItemProps) => {
    const { icon, color } = getStatusIcon(notification.status ?? "info");
    const isCompletion = notification.status === "completion";
    const isQuestion = notification.status === "question";
    const isError = notification.status === "error";
    const isShellCompletion = notification.agent === "shell" && isCompletion;

    const unreadBg = isShellCompletion
        ? "bg-blue-600/80 hover:bg-blue-600/90"
        : isCompletion
        ? "bg-green-700/70 hover:bg-green-700/80"
        : isQuestion
          ? "bg-yellow-600/70 hover:bg-yellow-600/80"
          : isError
            ? "bg-red-700/70 hover:bg-red-700/80"
            : "bg-blue-600/80 hover:bg-blue-600/90";

    const handleClick = useCallback(() => {
        onNavigate(notification);
    }, [notification, onNavigate]);

    const handleDismiss = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            clearAgentNotification(notification.notifyid);
        },
        [notification.notifyid]
    );

    return (
        <div
            className={cn(
                "group relative flex flex-col gap-0.5 px-2 py-2 border-b border-border/20 cursor-pointer transition-colors",
                isRead ? "hover:bg-hoverbg" : unreadBg
            )}
            onClick={handleClick}
            title="Click to navigate to this block"
        >
            {/* Status icon + message */}
            <div className="flex items-start gap-1.5">
                <i
                    className={cn("fa-solid shrink-0 mt-[1px] text-[11px]", icon)}
                    style={{ color }}
                />
                <span className={cn("text-[11px] leading-tight line-clamp-4 flex-1 min-w-0", isRead ? "text-primary" : "text-white")}>
                    {notification.timestamp > 0 && (
                        <span className={cn("mr-1.5 font-mono", isRead ? "text-secondary/50" : "text-white/50")}>
                            {formatTime(notification.timestamp)}
                        </span>
                    )}
                    {notification.message}
                </span>
                {/* Dismiss button — visible on hover */}
                <button
                    className={cn(
                        "shrink-0 opacity-0 group-hover:opacity-100 ml-0.5 -mt-0.5 transition-opacity",
                        isRead ? "text-secondary/40 hover:text-secondary" : "text-white/50 hover:text-white"
                    )}
                    onClick={handleDismiss}
                    title="Dismiss"
                    style={{ fontSize: "10px", lineHeight: 1 }}
                >
                    <i className="fa-solid fa-xmark" />
                </button>
            </div>

            {/* Metadata row: agent, branch, workdir */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px]">
                {notification.agent && (
                    <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0", isRead ? "text-secondary/60" : "text-white/70")}>
                        <i className="fa-solid fa-terminal shrink-0" style={{ fontSize: "9px" }} />
                        <span className="truncate">{notification.agent}</span>
                    </span>
                )}
                {notification.branch && (
                    <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0 max-w-full", isRead ? "text-secondary/60" : "text-white/70")}>
                        <i className="fa-solid fa-code-branch shrink-0" style={{ fontSize: "9px" }} />
                        <span className="truncate">{shortenBranch(notification.branch)}</span>
                    </span>
                )}
                {notification.workdir && (
                    <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0 max-w-full", isRead ? "text-secondary/50" : "text-white/60")}>
                        <i className="fa-solid fa-folder shrink-0" style={{ fontSize: "9px" }} />
                        <span className="truncate">{shortenPath(notification.workdir)}</span>
                    </span>
                )}
                {notification.worktree && (
                    <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0 max-w-full", isRead ? "text-secondary/50" : "text-white/60")}>
                        <i className="fa-solid fa-code-fork shrink-0" style={{ fontSize: "9px" }} />
                        <span className="truncate">{shortenPath(notification.worktree)}</span>
                    </span>
                )}
            </div>

        </div>
    );
});

AgentNotifyItem.displayName = "AgentNotifyItem";
