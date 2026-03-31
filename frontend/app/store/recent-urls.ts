// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const recentUrlsStorageKey = "webRecentUrls";
const maxRecentUrls = 100;

export type RecentUrlEntry = {
    url: string;
    lastVisitedTs: number;
};

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function normalizeRecentUrl(url: string | null | undefined): string | null {
    if (typeof url !== "string") {
        return null;
    }
    const trimmed = url.trim();
    if (trimmed === "" || trimmed === "about:blank") {
        return null;
    }
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

export function loadRecentUrls(): RecentUrlEntry[] {
    const storage = getStorage();
    if (storage == null) {
        return [];
    }
    const raw = storage.getItem(recentUrlsStorageKey);
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map((entry) => {
                const normalizedUrl = normalizeRecentUrl(entry?.url);
                const lastVisitedTs = Number(entry?.lastVisitedTs);
                if (normalizedUrl == null || !Number.isFinite(lastVisitedTs)) {
                    return null;
                }
                return { url: normalizedUrl, lastVisitedTs };
            })
            .filter((entry): entry is RecentUrlEntry => entry != null)
            .sort((a, b) => b.lastVisitedTs - a.lastVisitedTs);
    } catch {
        return [];
    }
}

export function saveRecentUrls(entries: RecentUrlEntry[]): void {
    const storage = getStorage();
    if (storage == null) {
        return;
    }
    storage.setItem(recentUrlsStorageKey, JSON.stringify(entries.slice(0, maxRecentUrls)));
}

export function recordRecentUrlVisit(url: string, now = Date.now()): RecentUrlEntry[] {
    const normalizedUrl = normalizeRecentUrl(url);
    if (normalizedUrl == null) {
        return loadRecentUrls();
    }
    const nextEntries = loadRecentUrls().filter((entry) => entry.url !== normalizedUrl);
    nextEntries.unshift({ url: normalizedUrl, lastVisitedTs: now });
    saveRecentUrls(nextEntries);
    return nextEntries.slice(0, maxRecentUrls);
}

export function clearRecentUrls(): void {
    const storage = getStorage();
    if (storage == null) {
        return;
    }
    storage.removeItem(recentUrlsStorageKey);
}

