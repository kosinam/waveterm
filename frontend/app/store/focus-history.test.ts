import { describe, expect, it } from "vitest";

import { getPreviousFocusLocationFromHistory, isSameFocusLocation, pushFocusLocation, type FocusLocation } from "./focus-history";

const paneA: FocusLocation = {
    workspaceId: "ws-a",
    tabId: "tab-a",
    focusType: "node",
    blockId: "block-a",
};

const paneB: FocusLocation = {
    workspaceId: "ws-b",
    tabId: "tab-b",
    focusType: "node",
    blockId: "block-b",
};

describe("focus-history", () => {
    it("deduplicates consecutive identical entries", () => {
        const history = pushFocusLocation(pushFocusLocation([], paneA), paneA);
        expect(history).toEqual([paneA]);
    });

    it("returns the last distinct focus location", () => {
        const history = [paneA, paneB, paneA];
        expect(getPreviousFocusLocationFromHistory(history, paneA)).toEqual(paneB);
    });

    it("treats wave ai and pane focus as different locations", () => {
        const waveAI: FocusLocation = {
            workspaceId: "ws-a",
            tabId: "tab-a",
            focusType: "waveai",
        };
        expect(isSameFocusLocation(paneA, waveAI)).toBe(false);
        expect(getPreviousFocusLocationFromHistory([paneA, waveAI], waveAI)).toEqual(paneA);
    });
});
