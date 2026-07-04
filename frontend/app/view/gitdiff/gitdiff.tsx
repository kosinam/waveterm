// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { DiffViewer } from "@/app/view/codeeditor/diffviewer";
import { WOS } from "@/store/global";
import { globalStore } from "@/store/jotaiStore";
import { base64ToString, makeConnRoute } from "@/util/util";
import clsx from "clsx";
import * as jotai from "jotai";
import { useEffect } from "react";

const StatusMeta: Record<string, { glyph: string; className: string; label: string }> = {
    added: { glyph: "A", className: "text-green-500", label: "Added" },
    modified: { glyph: "M", className: "text-yellow-500", label: "Modified" },
    deleted: { glyph: "D", className: "text-red-500", label: "Deleted" },
    renamed: { glyph: "R", className: "text-blue-400", label: "Renamed" },
    untracked: { glyph: "U", className: "text-green-400", label: "Untracked" },
};

function baseName(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.slice(idx + 1) : path;
}

export class GitDiffViewModel implements ViewModel {
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewType = "gitdiff";
    blockAtom: jotai.Atom<Block>;
    filesAtom: jotai.PrimitiveAtom<GitDiffFile[]>;
    selectedAtom: jotai.PrimitiveAtom<number>;
    errorAtom: jotai.PrimitiveAtom<string | null>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    viewText: jotai.Atom<string>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.filesAtom = jotai.atom<GitDiffFile[]>([]);
        this.selectedAtom = jotai.atom(0);
        this.errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.loadingAtom = jotai.atom<boolean>(true);
        this.viewIcon = jotai.atom("code-compare");
        this.viewName = jotai.atom("Git Diff");
        this.viewText = jotai.atom((get) => {
            const repoPath = get(this.blockAtom)?.meta?.["gitdiff:repopath"];
            return repoPath ?? "";
        });
    }

    get viewComponent(): ViewComponent {
        return GitDiffView;
    }
}

function GitDiffView({ blockId, model }: ViewComponentProps<GitDiffViewModel>) {
    const blockData = jotai.useAtomValue(model.blockAtom);
    const files = jotai.useAtomValue(model.filesAtom);
    const selected = jotai.useAtomValue(model.selectedAtom);
    const error = jotai.useAtomValue(model.errorAtom);
    const loading = jotai.useAtomValue(model.loadingAtom);

    const repoPath = blockData?.meta?.["gitdiff:repopath"];
    const connection = blockData?.meta?.connection;

    useEffect(() => {
        async function loadDiff() {
            globalStore.set(model.loadingAtom, true);
            globalStore.set(model.errorAtom, null);
            if (!repoPath) {
                globalStore.set(model.errorAtom, "Missing repo path in block metadata");
                globalStore.set(model.loadingAtom, false);
                return;
            }
            try {
                const result = await RpcApi.RemoteGitDiffCommand(
                    TabRpcClient,
                    { path: repoPath },
                    { route: makeConnRoute(connection) }
                );
                globalStore.set(model.filesAtom, result?.files ?? []);
                globalStore.set(model.selectedAtom, 0);
                globalStore.set(model.loadingAtom, false);
            } catch (e) {
                globalStore.set(model.errorAtom, `Error loading git diff: ${e.message}`);
                globalStore.set(model.loadingAtom, false);
            }
        }
        loadDiff();
    }, [repoPath, connection]);

    if (loading) {
        return (
            <div className="flex items-center justify-center w-full h-full">
                <div className="text-secondary">Loading diff…</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center w-full h-full">
                <div className="text-red-500">{error}</div>
            </div>
        );
    }

    if (files.length === 0) {
        return (
            <div className="flex items-center justify-center w-full h-full">
                <div className="text-secondary">No uncommitted changes</div>
            </div>
        );
    }

    const selectedFile = files[Math.min(selected, files.length - 1)];

    return (
        <div className="flex flex-row w-full h-full overflow-hidden">
            <div className="flex flex-col w-[260px] min-w-[200px] h-full overflow-y-auto border-r border-border py-1">
                {files.map((f, idx) => {
                    const meta = StatusMeta[f.status] ?? StatusMeta.modified;
                    const isSelected = idx === Math.min(selected, files.length - 1);
                    return (
                        <div
                            key={f.filename + idx}
                            className={clsx(
                                "flex flex-row items-center gap-2 px-3 py-1 cursor-pointer text-[12px] select-none",
                                isSelected ? "bg-hoverbg" : "hover:bg-hoverbg/60"
                            )}
                            onClick={() => globalStore.set(model.selectedAtom, idx)}
                            title={f.filename}
                        >
                            <span className={clsx("font-mono font-bold w-[10px] shrink-0", meta.className)} title={meta.label}>
                                {meta.glyph}
                            </span>
                            <span className="ellipsis flex-1" style={{ direction: "rtl", textAlign: "left" }}>
                                &lrm;{f.filename}
                            </span>
                            {(f.insertions || f.deletions) && (
                                <span className="shrink-0 text-[11px] font-mono">
                                    {f.insertions ? <span className="text-green-500">+{f.insertions}</span> : null}
                                    {f.deletions ? <span className="text-red-500 ml-1">−{f.deletions}</span> : null}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex-1 h-full overflow-hidden">
                {selectedFile.binary ? (
                    <div className="flex items-center justify-center w-full h-full text-secondary">
                        Binary file not shown
                    </div>
                ) : (
                    <DiffViewer
                        blockId={blockId}
                        original={base64ToString(selectedFile.original64)}
                        modified={base64ToString(selectedFile.modified64)}
                        fileName={baseName(selectedFile.filename)}
                    />
                )}
            </div>
        </div>
    );
}

export default GitDiffView;
