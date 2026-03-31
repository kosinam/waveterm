import { afterEach, describe, expect, it } from "vitest";

import { clearRecentUrls, recordRecentUrlVisit } from "@/app/store/recent-urls";

import { getMergedUrlSuggestions, getRecentUrlSuggestions } from "./webview-url-suggestions";

function installMockLocalStorage() {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
            clear: () => storage.clear(),
        } satisfies Partial<Storage>,
    });
}

describe("webview url suggestions", () => {
    afterEach(() => {
        installMockLocalStorage();
        clearRecentUrls();
    });

    installMockLocalStorage();

    it("returns recents newest-first for empty query", () => {
        recordRecentUrlVisit("https://b.example.com", 200);
        recordRecentUrlVisit("https://a.example.com", 100);
        expect(getRecentUrlSuggestions("").map((item) => item["url:url"])).toEqual([
            "https://b.example.com/",
            "https://a.example.com/",
        ]);
    });

    it("merges bookmark visuals onto matching recent urls", () => {
        recordRecentUrlVisit("https://docs.example.com/path", 500);
        const merged = getMergedUrlSuggestions("docs", [
            {
                type: "url",
                suggestionid: "bookmark-1",
                display: "Example Docs",
                subtext: "https://docs.example.com/path",
                iconsrc: "https://docs.example.com/favicon.ico",
                score: 9000,
                "url:url": "https://docs.example.com/path",
            },
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].display).toBe("Example Docs");
        expect(merged[0].subtext).toBe("https://docs.example.com/path");
        expect(merged[0].iconsrc).toBe("https://docs.example.com/favicon.ico");
    });

    it("shows recent urls before unmatched bookmarks for empty query", () => {
        recordRecentUrlVisit("https://recent.example.com", 500);
        const merged = getMergedUrlSuggestions("", [
            {
                type: "url",
                suggestionid: "bookmark-1",
                display: "Bookmark",
                score: 0,
                "url:url": "https://bookmark.example.com",
            },
        ]);
        expect(merged.map((item) => item["url:url"])).toEqual([
            "https://recent.example.com/",
            "https://bookmark.example.com/",
        ]);
    });
});
