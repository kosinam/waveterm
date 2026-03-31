// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { loadRecentUrls, normalizeRecentUrl } from "@/app/store/recent-urls";

type UrlSuggestionWithMeta = SuggestionType & {
    lastVisitedTs?: number;
    sourceOrder?: number;
};

function getHighlightPositions(target: string, startIdx: number, length: number): number[] {
    return Array.from({ length }, (_, idx) => startIdx + idx).filter((idx) => idx >= 0 && idx < target.length);
}

function scoreRecentUrlMatch(url: string, query: string): { score: number; matchPos: number[] } | null {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === "") {
        return { score: 0, matchPos: [] };
    }

    const urlLower = url.toLowerCase();
    const urlIdx = urlLower.indexOf(normalizedQuery);
    let hostname = "";
    try {
        hostname = new URL(url).hostname.toLowerCase();
    } catch {
        hostname = "";
    }
    const hostIdx = hostname.indexOf(normalizedQuery);

    if (hostIdx === 0) {
        const absoluteStart = urlLower.indexOf(hostname);
        return {
            score: 4000 - normalizedQuery.length,
            matchPos: getHighlightPositions(url, absoluteStart, normalizedQuery.length),
        };
    }
    if (hostIdx > 0) {
        const absoluteStart = urlLower.indexOf(hostname) + hostIdx;
        return {
            score: 3000 - hostIdx,
            matchPos: getHighlightPositions(url, absoluteStart, normalizedQuery.length),
        };
    }
    if (urlIdx === 0) {
        return {
            score: 2000 - normalizedQuery.length,
            matchPos: getHighlightPositions(url, 0, normalizedQuery.length),
        };
    }
    if (urlIdx > 0) {
        return {
            score: 1000 - urlIdx,
            matchPos: getHighlightPositions(url, urlIdx, normalizedQuery.length),
        };
    }
    return null;
}

export function getRecentUrlSuggestions(query: string): UrlSuggestionWithMeta[] {
    const recentUrls = loadRecentUrls();
    if (!query?.trim()) {
        return recentUrls.map((entry, idx) => ({
            type: "url",
            suggestionid: `recent:${entry.url}`,
            display: entry.url,
            score: 0,
            "url:url": entry.url,
            lastVisitedTs: entry.lastVisitedTs,
            sourceOrder: idx,
        }));
    }

    return recentUrls
        .map((entry, idx) => {
            const match = scoreRecentUrlMatch(entry.url, query);
            if (match == null) {
                return null;
            }
            return {
                type: "url",
                suggestionid: `recent:${entry.url}`,
                display: entry.url,
                matchpos: match.matchPos,
                score: match.score,
                "url:url": entry.url,
                lastVisitedTs: entry.lastVisitedTs,
                sourceOrder: idx,
            } as UrlSuggestionWithMeta;
        })
        .filter((entry): entry is UrlSuggestionWithMeta => entry != null)
        .sort((a, b) => {
            if ((b.score ?? 0) !== (a.score ?? 0)) {
                return (b.score ?? 0) - (a.score ?? 0);
            }
            return (b.lastVisitedTs ?? 0) - (a.lastVisitedTs ?? 0);
        });
}

function mergeSuggestion(
    existing: UrlSuggestionWithMeta | undefined,
    incoming: UrlSuggestionWithMeta,
    preferIncomingVisuals: boolean
): UrlSuggestionWithMeta {
    if (existing == null) {
        return incoming;
    }
    const merged: UrlSuggestionWithMeta = {
        ...existing,
        ...incoming,
        score: Math.max(existing.score ?? 0, incoming.score ?? 0),
        lastVisitedTs: Math.max(existing.lastVisitedTs ?? 0, incoming.lastVisitedTs ?? 0),
        sourceOrder: Math.min(existing.sourceOrder ?? Number.MAX_SAFE_INTEGER, incoming.sourceOrder ?? Number.MAX_SAFE_INTEGER),
    };
    if (preferIncomingVisuals) {
        merged.display = incoming.display || existing.display;
        merged.subtext = incoming.subtext ?? existing.subtext;
        merged.icon = incoming.icon ?? existing.icon;
        merged.iconcolor = incoming.iconcolor ?? existing.iconcolor;
        merged.iconsrc = incoming.iconsrc ?? existing.iconsrc;
        merged.matchpos = incoming.matchpos ?? existing.matchpos;
        merged.submatchpos = incoming.submatchpos ?? existing.submatchpos;
    }
    return merged;
}

export function mergeUrlSuggestions(bookmarks: SuggestionType[], recentUrls = getRecentUrlSuggestions("")): SuggestionType[] {
    const mergedByUrl = new Map<string, UrlSuggestionWithMeta>();
    const recentWithMeta = recentUrls.map((suggestion, idx) => ({ ...suggestion, sourceOrder: idx }));
    const bookmarksWithMeta = bookmarks.map((suggestion, idx) => ({ ...suggestion, sourceOrder: idx }));
    const queryIsEmpty = recentWithMeta.every((suggestion) => (suggestion.score ?? 0) === 0) && bookmarksWithMeta.every((suggestion) => (suggestion.score ?? 0) === 0);

    for (const suggestion of recentWithMeta) {
        const url = normalizeRecentUrl(suggestion["url:url"]) ?? suggestion["url:url"];
        if (!url) {
            continue;
        }
        mergedByUrl.set(url, mergeSuggestion(mergedByUrl.get(url), { ...suggestion, "url:url": url }, false));
    }
    for (const suggestion of bookmarksWithMeta) {
        const url = normalizeRecentUrl(suggestion["url:url"]) ?? suggestion["url:url"];
        if (!url) {
            continue;
        }
        mergedByUrl.set(url, mergeSuggestion(mergedByUrl.get(url), { ...suggestion, "url:url": url }, true));
    }

    const merged = [...mergedByUrl.values()];
    if (queryIsEmpty) {
        merged.sort((a, b) => {
            const aHasRecent = (a.lastVisitedTs ?? 0) > 0;
            const bHasRecent = (b.lastVisitedTs ?? 0) > 0;
            if (aHasRecent !== bHasRecent) {
                return aHasRecent ? -1 : 1;
            }
            if (aHasRecent && bHasRecent && (b.lastVisitedTs ?? 0) !== (a.lastVisitedTs ?? 0)) {
                return (b.lastVisitedTs ?? 0) - (a.lastVisitedTs ?? 0);
            }
            return (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0);
        });
    } else {
        merged.sort((a, b) => {
            if ((b.score ?? 0) !== (a.score ?? 0)) {
                return (b.score ?? 0) - (a.score ?? 0);
            }
            if ((b.lastVisitedTs ?? 0) !== (a.lastVisitedTs ?? 0)) {
                return (b.lastVisitedTs ?? 0) - (a.lastVisitedTs ?? 0);
            }
            return (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0);
        });
    }
    return merged;
}

export function getMergedUrlSuggestions(query: string, bookmarkSuggestions: SuggestionType[]): SuggestionType[] {
    return mergeUrlSuggestions(bookmarkSuggestions, getRecentUrlSuggestions(query));
}
