// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as keyutil from "@/util/keyutil";
import { atom, useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import "./bottombar.scss";

type BottomBarRequest = {
    prompt: string;
    onSubmit: (value: string) => void;
};

// null = hidden; non-null = visible with prompt config
const bottomBarRequestAtom = atom<BottomBarRequest | null>(null);

const BottomBar = () => {
    const [request, setRequest] = useAtom(bottomBarRequestAtom);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (request != null) {
            inputRef.current?.focus();
        }
    }, [request]);

    const close = useCallback(() => {
        setRequest(null);
    }, [setRequest]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e.nativeEvent);
            if (keyutil.checkKeyPressed(waveEvent, "Escape")) {
                e.stopPropagation();
                close();
                return;
            }
            if (keyutil.checkKeyPressed(waveEvent, "Enter")) {
                e.stopPropagation();
                const val = inputRef.current?.value?.trim();
                if (val) {
                    request?.onSubmit(val);
                }
                close();
                return;
            }
            // prevent global key handlers from seeing keystrokes meant for this input
            e.stopPropagation();
        },
        [close, request]
    );

    if (request == null) {
        return null;
    }

    return (
        <div className="bottom-bar">
            <span className="bottom-bar-prompt">{request.prompt}</span>
            <input
                ref={inputRef}
                className="bottom-bar-input"
                type="text"
                spellCheck={false}
                onKeyDown={handleKeyDown}
                onBlur={close}
            />
        </div>
    );
};

BottomBar.displayName = "BottomBar";

export { BottomBar, bottomBarRequestAtom };
