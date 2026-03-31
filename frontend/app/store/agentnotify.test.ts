import { describe, expect, it } from "vitest";

import { shouldResetReadState } from "./agentnotify";

function makeNotification(overrides: Partial<AgentNotification> = {}): AgentNotification {
    return {
        notifyid: "n1",
        oref: "block:b1",
        tabid: "t1",
        workspaceid: "w1",
        windowid: "win1",
        agent: "codex",
        status: "question",
        message: "Approval required",
        timestamp: 100,
        ...overrides,
    };
}

describe("agentnotify read reset policy", () => {
    it("marks a new actionable notification unread", () => {
        expect(shouldResetReadState(null, makeNotification())).toBe(true);
    });

    it("keeps a read question read on timestamp-only refresh", () => {
        const existing = makeNotification({ agent: "claude", notifyid: "n1", timestamp: 100 });
        const incoming = makeNotification({ agent: "claude", notifyid: "n1", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(false);
    });

    it("re-alerts repeated Codex question prompts for the same block", () => {
        const existing = makeNotification({ notifyid: "codex-question:b1", timestamp: 100 });
        const incoming = makeNotification({ notifyid: "codex-question:b1", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(true);
    });

    it("marks a read question unread when it resolves to completion", () => {
        const existing = makeNotification({ status: "question", message: "Approval required" });
        const incoming = makeNotification({ status: "completion", message: "Done", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(true);
    });

    it("re-alerts when a question message changes", () => {
        const existing = makeNotification({ status: "question", message: "Approval required" });
        const incoming = makeNotification({ status: "question", message: "Approval required for a different command", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(true);
    });

    it("keeps a read error read when the same error is republished", () => {
        const existing = makeNotification({ status: "error", message: "Command failed" });
        const incoming = makeNotification({ status: "error", message: "Command failed", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(false);
    });

    it("keeps a read completion read on timestamp-only refresh", () => {
        const existing = makeNotification({ status: "completion", message: "Done", timestamp: 100 });
        const incoming = makeNotification({ status: "completion", message: "Done", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(false);
    });

    it("re-alerts when a new actionable error replaces completion", () => {
        const existing = makeNotification({ status: "completion", message: "Done" });
        const incoming = makeNotification({ status: "error", message: "A later command failed", timestamp: 200 });
        expect(shouldResetReadState(existing, incoming)).toBe(true);
    });
});
