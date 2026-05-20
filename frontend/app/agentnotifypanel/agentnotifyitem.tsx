// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { agentInProgressAtom, clearAgentNotification, getInProgressStartMs } from "@/app/store/agentnotify";
import { getTabMetaKeyAtom } from "@/app/store/global";
import { cn, isLocalConnName } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useState } from "react";

const folderBlue = "#5BAAFF";
const folderBlueText = "color-mix(in srgb, #5BAAFF 60%, white)";

function formatTime(timestampMs: number): string {
    if (!timestampMs) return "";
    const d = new Date(timestampMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

function shortenBranch(branch: string): string {
    if (!branch) return "";
    if (branch.length <= 24) return branch;
    return branch.substring(0, 22) + "…";
}

function getConnHostname(connName: string): string {
    if (!connName || isLocalConnName(connName)) return "";
    if (connName.startsWith("wsl://")) return connName.slice(6);
    const atIdx = connName.indexOf("@");
    const host = atIdx >= 0 ? connName.slice(atIdx + 1) : connName;
    const dotIdx = host.indexOf(".");
    return dotIdx >= 0 ? host.slice(0, dotIdx) : host;
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

    const inProgressMap = useAtomValue(agentInProgressAtom);
    const inProgress = inProgressMap.get(notification.notifyid);

    const isInProgress = inProgress != null;
    const [elapsed, setElapsed] = useState(() =>
        isInProgress ? Math.floor((Date.now() - getInProgressStartMs(notification.notifyid)) / 1000) : 0
    );
    useEffect(() => {
        if (!isInProgress) {
            setElapsed(0);
            return;
        }
        const startMs = getInProgressStartMs(notification.notifyid);
        const update = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [isInProgress, notification.notifyid]);

    const connName = notification.connection ?? "";
    const isRemote = !isLocalConnName(connName);
    const connHostname = isRemote ? getConnHostname(connName) : "";
    const workdirDisplay =
        connHostname && notification.workdir ? `${connHostname}:${notification.workdir}` : notification.workdir;

    const tabFlagColor = useAtomValue(getTabMetaKeyAtom(notification.tabid ?? "", "tab:flagcolor"));
    const flagColor = tabFlagColor ? `color-mix(in srgb, ${tabFlagColor} 60%, white)` : "#ffffff";

    const topicColor = isRead ? "text-primary/60" : "text-white/75";
    const metaColor = isRead ? "text-secondary/70" : "text-white/75";

    const unreadBg = isShellCompletion
        ? "bg-blue-700/80 hover:bg-blue-700/90"
        : isCompletion
        ? "bg-green-800/70 hover:bg-green-800/80"
        : isQuestion
          ? "bg-yellow-500/55 hover:bg-yellow-500/65"
          : isError
            ? "bg-red-800/70 hover:bg-red-800/80"
            : "bg-blue-700/80 hover:bg-blue-700/90";

    const pulsePeak = "rgba(255, 255, 255, 0.18)";
    const showAccentBorder = !isRead && !isInProgress;
    const itemStyle: React.CSSProperties = {
        ...(isInProgress
            ? ({ animation: "agent-bg-pulse-dynamic 3s ease-in-out infinite", "--pulse-color": pulsePeak } as React.CSSProperties)
            : {}),
        ...(showAccentBorder ? { boxShadow: "inset 0 0 0 2px var(--block-border-color)" } : {}),
    };

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
                "group relative flex flex-col gap-0.5 px-2 py-2 rounded-md border border-border/20 cursor-pointer transition-colors",
                !isInProgress && (isRead ? "bg-white/5 hover:bg-white/10" : unreadBg)
            )}
            style={itemStyle}
            onClick={handleClick}
            title="Click to navigate to this block"
        >
            <div className="flex items-start gap-1.5">
                <i
                    className={cn("fa-solid shrink-0 mt-[1px] text-[11px]", icon)}
                    style={{ color }}
                />
                <div className={cn("text-[11px] leading-tight flex-1 min-w-0", isRead ? "text-primary" : "text-white")}>
                    {notification.topic && (
                        <div className={cn("font-semibold mb-0.5 line-clamp-1", topicColor)}>
                            {notification.topic}
                        </div>
                    )}
                    {/* Row 1: tab name + workdir path */}
                    {(notification.tabname || notification.workdir) && (
                        <div className="flex flex-nowrap items-center gap-x-2 mb-0.5 min-w-0 overflow-hidden">
                            {notification.tabname && (
                                <span className="flex items-center gap-1 text-[10px] font-semibold min-w-0" style={{ color: flagColor }}>
                                    <i className="fa-solid fa-flag shrink-0" style={{ fontSize: "9px" }} />
                                    <span className="truncate">{notification.tabname}</span>
                                </span>
                            )}
                            {notification.workdir && (
                                <span className="flex items-center gap-1 text-[10px] min-w-0">
                                    <i
                                        className={cn(
                                            isRemote
                                                ? "fa-solid fa-arrow-right-arrow-left"
                                                : "fa-solid fa-laptop",
                                            "shrink-0"
                                        )}
                                        style={{
                                            fontSize: "9px",
                                            color: isRemote ? folderBlue : "var(--color-secondary)",
                                        }}
                                    />
                                    <span className="truncate" style={{ color: folderBlueText }}>{workdirDisplay}</span>
                                </span>
                            )}
                        </div>
                    )}
                    {/* Row 2: agent + main branch + worktree branch (worktree only when in a linked worktree) */}
                    {(notification.agent || notification.branch || notification.worktree) && (
                        <div className="flex flex-nowrap items-center gap-x-2 mb-0.5 min-w-0 overflow-hidden">
                            {notification.agent && (
                                <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0", metaColor)}>
                                    <i className="fa-solid fa-terminal shrink-0" style={{ fontSize: "9px" }} />
                                    <span className="truncate">{notification.agent}</span>
                                </span>
                            )}
                            {notification.branch && (
                                <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0", metaColor)}>
                                    <i className="fa-solid fa-code-branch shrink-0" style={{ fontSize: "9px" }} />
                                    <span className="truncate">{shortenBranch(notification.branch)}</span>
                                </span>
                            )}
                            {notification.worktree && (
                                <span className={cn("flex items-center gap-0.5 text-[10px] min-w-0", metaColor)}>
                                    <i className="fa-solid fa-code-fork shrink-0" style={{ fontSize: "9px" }} />
                                    <span className="truncate">{notification.worktree}</span>
                                </span>
                            )}
                        </div>
                    )}
                    {inProgress ? (
                        <div className="h-[52px] overflow-hidden">
                            <div className={cn("text-[10px] line-clamp-4", isRead ? "text-secondary/80" : "text-white/80")}>
                                <span className="text-green-400 mr-0.5" style={{ fontSize: "11px", animation: "agent-glow 1s ease-in-out infinite" }}>●</span>
                                <span className={cn("font-mono mr-1.5", elapsed >= 600 ? "text-red-400" : elapsed >= 300 ? "text-yellow-400" : isRead ? "text-secondary/65" : "text-white/65")}>
                                    {formatElapsed(elapsed)}
                                </span>
                                {inProgress.message}
                            </div>
                        </div>
                    ) : (
                        <div className="h-[52px] overflow-hidden">
                            <div className="line-clamp-4">
                                {notification.timestamp > 0 && (
                                    <span className={cn("mr-1.5 font-mono", isRead ? "text-secondary/65" : "text-white/65")}>
                                        {formatTime(notification.timestamp)}
                                    </span>
                                )}
                                <span className="italic">{notification.message}</span>
                            </div>
                        </div>
                    )}
                </div>
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
        </div>
    );
});

AgentNotifyItem.displayName = "AgentNotifyItem";
