import { afterEach, describe, expect, it } from "vitest";

import { clearRecentUrls, loadRecentUrls, normalizeRecentUrl, recordRecentUrlVisit } from "./recent-urls";

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

describe("recent-urls", () => {
    afterEach(() => {
        installMockLocalStorage();
        clearRecentUrls();
    });

    installMockLocalStorage();

    it("normalizes supported urls and rejects blank/unsupported values", () => {
        expect(normalizeRecentUrl(" https://example.com ")).toBe("https://example.com/");
        expect(normalizeRecentUrl("about:blank")).toBeNull();
        expect(normalizeRecentUrl("javascript:alert(1)")).toBeNull();
    });

    it("records newest-first and deduplicates revisits", () => {
        recordRecentUrlVisit("https://example.com/a", 100);
        recordRecentUrlVisit("https://example.com/b", 200);
        recordRecentUrlVisit("https://example.com/a", 300);
        expect(loadRecentUrls()).toEqual([
            { url: "https://example.com/a", lastVisitedTs: 300 },
            { url: "https://example.com/b", lastVisitedTs: 200 },
        ]);
    });

    it("ignores invalid urls", () => {
        recordRecentUrlVisit("not a url", 100);
        expect(loadRecentUrls()).toEqual([]);
    });
});
