// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WebviewTag } from "electron";
import darkReaderScript from "darkreader/darkreader.js?raw";

const LOAD_GUARD = "(function(){ return !!(window.DarkReader && window.DarkReader.enable); })();";

const ENABLE_SCRIPT =
    ";(function(){ if (window.DarkReader && window.DarkReader.enable) { window.DarkReader.enable({ brightness: 100, contrast: 90, sepia: 0 }); } })();";

const DISABLE_SCRIPT =
    "(function(){ if (window.DarkReader && window.DarkReader.disable) { window.DarkReader.disable(); } })();";

export async function applyDarkReader(webview: WebviewTag | null, enabled: boolean): Promise<void> {
    if (!webview) return;
    try {
        if (enabled) {
            const loaded = await webview.executeJavaScript(LOAD_GUARD);
            if (!loaded) {
                await webview.executeJavaScript(darkReaderScript);
            }
            await webview.executeJavaScript(ENABLE_SCRIPT);
        } else {
            await webview.executeJavaScript(DISABLE_SCRIPT);
        }
    } catch (e) {
        console.warn("DarkReader inject failed", e);
    }
}
