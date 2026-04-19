// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-20

import { session, Session } from "electron";

const BLOCKED_HEADERS = [
    "content-security-policy",
    "x-frame-options",
    "content-security-policy-report-only",
    "x-xss-protection",
];

export function configureWebviewResponseHeaderStripping(webviewSession: Session) {
    const filter = { urls: ["*://*/*"] };

    webviewSession.webRequest.onHeadersReceived(filter, (details, callback) => {
        const headers = details.responseHeaders;
        if (!headers) {
            callback({});
            return;
        }

        let modified = false;
        for (const headerName of BLOCKED_HEADERS) {
            if (headerName in headers) {
                delete headers[headerName];
                modified = true;
            }
        }

        if (modified) {
            callback({ responseHeaders: headers });
        } else {
            callback({});
        }
    });
}
