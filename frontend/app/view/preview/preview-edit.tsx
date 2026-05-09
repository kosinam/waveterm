// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOverrideConfigAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { tryReinjectKey } from "@/app/store/keymodel";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { adaptFromReactOrNativeKeyEvent, checkKeyPressed } from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import * as monaco from "monaco-editor";
import { VimMode } from "monaco-vim";
import { useEffect } from "react";
import type { SpecializedViewProps } from "./preview";

export const shellFileMap: Record<string, string> = {
    ".bashrc": "shell",
    ".bash_profile": "shell",
    ".bash_login": "shell",
    ".bash_logout": "shell",
    ".profile": "shell",
    ".zshrc": "shell",
    ".zprofile": "shell",
    ".zshenv": "shell",
    ".zlogin": "shell",
    ".zlogout": "shell",
    ".kshrc": "shell",
    ".cshrc": "shell",
    ".tcshrc": "shell",
    ".xonshrc": "python",
    ".shrc": "shell",
    ".aliases": "shell",
    ".functions": "shell",
    ".exports": "shell",
    ".direnvrc": "shell",
    ".vimrc": "shell",
    ".gvimrc": "shell",
};

function CodeEditPreview({ model }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const setNewFileContent = useSetAtom(model.newFileContent);
    const fileInfo = useAtomValue(model.statFile);
    const fileName = fileInfo?.path || fileInfo?.name;

    const baseName = fileName ? fileName.split("/").pop() : null;
    const language = baseName && shellFileMap[baseName] ? shellFileMap[baseName] : undefined;

    function codeEditKeyDownHandler(e: WaveKeyboardEvent): boolean {
        if (checkKeyPressed(e, "Cmd:e")) {
            fireAndForget(() => model.setEditMode(false));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:s") || checkKeyPressed(e, "Ctrl:s")) {
            fireAndForget(model.handleFileSave.bind(model));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:r")) {
            fireAndForget(model.handleFileRevert.bind(model));
            return true;
        }
        return false;
    }

    useEffect(() => {
        model.codeEditKeyDownHandler = codeEditKeyDownHandler;
        model.refreshCallback = () => {
            globalStore.set(model.refreshVersion, (v) => v + 1);
        };
        return () => {
            model.codeEditKeyDownHandler = null;
            model.monacoRef.current = null;
            model.refreshCallback = null;
        };
    }, []);

    function onMount(editor: MonacoTypes.editor.IStandaloneCodeEditor, monacoApi: typeof monaco): () => void {
        model.monacoRef.current = editor;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Vim = (VimMode as any).Vim;
        Vim.defineEx("write", "w", () => {
            fireAndForget(model.handleFileSave.bind(model));
        });
        Vim.defineEx("quit", "q", (_cm: unknown, params: { argString?: string }) => {
            const force = params?.argString?.trim() === "!";
            const hasChanges = globalStore.get(model.newFileContent) != null;
            if (!force && hasChanges) {
                throw new Error("No write since last change (add ! to override)");
            }
            fireAndForget(async () => {
                if (hasChanges) globalStore.set(model.newFileContent, null);
                await model.goHistoryBack();
            });
        });
        Vim.defineEx("wq", "wq", () => {
            fireAndForget(async () => {
                await model.handleFileSave();
                await model.goHistoryBack();
            });
        });
        Vim.defineEx("xit", "x", () => {
            fireAndForget(async () => {
                if (globalStore.get(model.newFileContent) != null) await model.handleFileSave();
                await model.goHistoryBack();
            });
        });

        const keyDownDisposer = editor.onKeyDown((e: MonacoTypes.IKeyboardEvent) => {
            const vimModeActive = globalStore.get(getOverrideConfigAtom(model.blockId, "editor:vimmode")) ?? false;
            if (vimModeActive && !e.browserEvent.metaKey && !e.browserEvent.ctrlKey) {
                return;
            }
            const waveEvent = adaptFromReactOrNativeKeyEvent(e.browserEvent);
            const handled = tryReinjectKey(waveEvent);
            if (handled) {
                e.stopPropagation();
                e.preventDefault();
            }
        });

        const isFocused = globalStore.get(model.nodeModel.isFocused);
        if (isFocused) {
            editor.focus();
        }

        return () => {
            keyDownDisposer.dispose();
        };
    }

    return (
        <CodeEditor
            blockId={model.blockId}
            text={fileContent}
            fileName={fileName}
            language={language}
            readonly={fileInfo.readonly}
            onChange={(text) => setNewFileContent(text)}
            onMount={onMount}
        />
    );
}

export { CodeEditPreview };
