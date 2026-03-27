// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi, globalStore } from "@/app/store/global";
import { atoms } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { modalsModel } from "@/app/store/modalmodel";
import * as keyutil from "@/util/keyutil";
import { makeIconClass } from "@/util/util";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import "./workspacepickermodal.scss";

type WorkspaceEntry = {
    workspaceid: string;
    windowid: string;
    workspace: Workspace;
};

const WorkspacePickerModal = () => {
    const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const currentWorkspaceId = globalStore.get(atoms.workspaceId);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        (async () => {
            const list = await WorkspaceService.ListWorkspaces();
            if (!list) return;
            const full: WorkspaceEntry[] = await Promise.all(
                list.map(async (entry) => ({
                    ...entry,
                    workspace: await WorkspaceService.GetWorkspace(entry.workspaceid),
                }))
            );
            setEntries(full);
            // pre-select current workspace
            const curIdx = full.findIndex((e) => e.workspaceid === currentWorkspaceId);
            if (curIdx >= 0) setSelectedIdx(curIdx);
        })();
    }, []);

    // scroll selected item into view
    useEffect(() => {
        const item = listRef.current?.querySelector<HTMLElement>(".ws-picker-item.selected");
        item?.scrollIntoView({ block: "nearest" });
    }, [selectedIdx]);

    const close = () => modalsModel.popModal();

    const confirm = (idx: number) => {
        const entry = entries[idx];
        if (entry) {
            getApi().switchWorkspace(entry.workspaceid);
        }
        close();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e.nativeEvent);
        if (keyutil.checkKeyPressed(waveEvent, "ArrowUp")) {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
        } else if (keyutil.checkKeyPressed(waveEvent, "ArrowDown")) {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(entries.length - 1, i + 1));
        } else if (keyutil.checkKeyPressed(waveEvent, "Enter")) {
            e.preventDefault();
            confirm(selectedIdx);
        } else if (keyutil.checkKeyPressed(waveEvent, "Escape")) {
            e.preventDefault();
            close();
        }
    };

    return (
        <div className="ws-picker-backdrop" onMouseDown={close}>
            <div
                className="ws-picker"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={handleKeyDown}
                tabIndex={-1}
                ref={(el) => el?.focus()}
            >
                <div className="ws-picker-title">workspaces</div>
                <div className="ws-picker-list" ref={listRef}>
                    {entries.map((entry, idx) => {
                        const ws = entry.workspace;
                        const isCurrent = entry.workspaceid === currentWorkspaceId;
                        const isSelected = idx === selectedIdx;
                        const isOpen = !!entry.windowid;
                        return (
                            <div
                                key={entry.workspaceid}
                                className={clsx("ws-picker-item", { selected: isSelected, current: isCurrent })}
                                onMouseEnter={() => setSelectedIdx(idx)}
                                onClick={() => confirm(idx)}
                            >
                                <span className="ws-picker-icon">
                                    {ws.icon ? (
                                        <i
                                            className={makeIconClass(ws.icon, false)}
                                            style={{ color: ws.color }}
                                        />
                                    ) : (
                                        <i className="fa-sharp fa-solid fa-list" />
                                    )}
                                </span>
                                <span className="ws-picker-name">{ws.name || "(unnamed)"}</span>
                                {isCurrent && <span className="ws-picker-badge current-badge">current</span>}
                                {!isCurrent && isOpen && <span className="ws-picker-badge open-badge">open</span>}
                            </div>
                        );
                    })}
                    {entries.length === 0 && (
                        <div className="ws-picker-empty">loading…</div>
                    )}
                </div>
            </div>
        </div>
    );
};

WorkspacePickerModal.displayName = "WorkspacePickerModal";

export { WorkspacePickerModal };
