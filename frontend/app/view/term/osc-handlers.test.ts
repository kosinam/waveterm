import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { agentNotifyCommand, clearAgentNotificationCommand } = vi.hoisted(() => ({
    agentNotifyCommand: vi.fn().mockResolvedValue(undefined),
    clearAgentNotificationCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        AgentNotifyCommand: agentNotifyCommand,
        ClearAgentNotificationCommand: clearAgentNotificationCommand,
    },
}));

import {
    clearCodexApprovalNotification,
    isClaudeCodeCommand,
    isCodexCommand,
    markCodexTurnCompleted,
    observeTerminalOutputForCodexApproval,
    setRunningShellCommand,
} from "./osc-handlers";

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
}

describe("isClaudeCodeCommand", () => {
    it("matches direct Claude Code invocations", () => {
        expect(isClaudeCodeCommand("claude")).toBe(true);
        expect(isClaudeCodeCommand("claude --dangerously-skip-permissions")).toBe(true);
    });

    it("matches Claude Code invocations wrapped with env assignments", () => {
        expect(isClaudeCodeCommand('ANTHROPIC_API_KEY="test" claude')).toBe(true);
        expect(isClaudeCodeCommand("env FOO=bar claude --print")).toBe(true);
    });

    it("ignores other commands", () => {
        expect(isClaudeCodeCommand("claudes")).toBe(false);
        expect(isClaudeCodeCommand("echo claude")).toBe(false);
        expect(isClaudeCodeCommand("ls ~/claude")).toBe(false);
        expect(isClaudeCodeCommand("cat /logs/claude")).toBe(false);
        expect(isClaudeCodeCommand("")).toBe(false);
    });
});

describe("isCodexCommand", () => {
    it("matches direct Codex invocations", () => {
        expect(isCodexCommand("codex")).toBe(true);
        expect(isCodexCommand("codex exec --full-auto")).toBe(true);
    });

    it("matches Codex invocations wrapped with env assignments", () => {
        expect(isCodexCommand('OPENAI_API_KEY="test" codex')).toBe(true);
        expect(isCodexCommand("env FOO=bar codex --model gpt-5")).toBe(true);
    });

    it("ignores other commands", () => {
        expect(isCodexCommand("codexes")).toBe(false);
        expect(isCodexCommand("echo codex")).toBe(false);
        expect(isCodexCommand("ls ~/codex")).toBe(false);
        expect(isCodexCommand("cat /logs/codex")).toBe(false);
        expect(isCodexCommand("")).toBe(false);
    });
});

describe("Codex pause detection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));
        agentNotifyCommand.mockClear();
        clearAgentNotificationCommand.mockClear();
        setRunningShellCommand("b1", "codex");
        setRunningShellCommand("b2", "codex");
        setRunningShellCommand("b1", null);
        setRunningShellCommand("b2", null);
    });

    afterEach(async () => {
        clearCodexApprovalNotification("b1");
        clearCodexApprovalNotification("b2");
        markCodexTurnCompleted("b1");
        markCodexTurnCompleted("b2");
        setRunningShellCommand("b1", null);
        setRunningShellCommand("b2", null);
        await flushMicrotasks();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it("raises a question notification after 5s of Codex output silence", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(4999);
        await flushMicrotasks();
        expect(agentNotifyCommand).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);
        expect(agentNotifyCommand.mock.calls[0]?.[1]).toMatchObject({
            notifyid: "codex-question:b1",
            agent: "codex",
            status: "question",
            message: "Codex output paused",
        });
    });

    it("does not arm for non-Codex commands", async () => {
        observeTerminalOutputForCodexApproval("b1", "Running tests...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).not.toHaveBeenCalled();
    });

    it("clears the notification when output resumes", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);

        observeTerminalOutputForCodexApproval("b1", "Still working...\r\n");
        await flushMicrotasks();
        expect(clearAgentNotificationCommand).toHaveBeenCalledWith(undefined, "codex-question:b1");
    });

    it("clears the notification when the active turn ends", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);

        clearCodexApprovalNotification("b1");
        observeTerminalOutputForCodexApproval("b1", "");
        await flushMicrotasks();
        expect(clearAgentNotificationCommand).toHaveBeenCalledWith(undefined, "codex-question:b1");
    });

    it("reuses the same notify id across repeated pauses in one turn", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();

        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");
        await flushMicrotasks();

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();

        expect(agentNotifyCommand).toHaveBeenCalledTimes(2);
        expect(agentNotifyCommand.mock.calls[0]?.[1]).toMatchObject({ notifyid: "codex-question:b1" });
        expect(agentNotifyCommand.mock.calls[1]?.[1]).toMatchObject({ notifyid: "codex-question:b1" });
    });

    it("suppresses pause notifications after the turn is marked completed", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");
        markCodexTurnCompleted("b1");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();

        expect(agentNotifyCommand).not.toHaveBeenCalled();
    });

    it("clears an active pause notification when the turn is marked completed", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);

        markCodexTurnCompleted("b1");
        await flushMicrotasks();

        expect(clearAgentNotificationCommand).toHaveBeenCalledWith(undefined, "codex-question:b1");
    });

    it("re-arms pause detection when a new Codex command starts after completion", async () => {
        markCodexTurnCompleted("b1");
        observeTerminalOutputForCodexApproval("b1", "Workin\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).not.toHaveBeenCalled();

        setRunningShellCommand("b1", "codex");
        observeTerminalOutputForCodexApproval("b1", "Workin\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);
    });

    it("re-arms pause detection from a strong Working status line after completion", async () => {
        markCodexTurnCompleted("b1");

        observeTerminalOutputForCodexApproval("b1", "•Working(0s • esc to interrupt)\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);
    });

    it("keeps suppression for non-status visible text after completion", async () => {
        markCodexTurnCompleted("b1");

        observeTerminalOutputForCodexApproval("b1", "Would you like to run the following command?\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).not.toHaveBeenCalled();
    });

    it("refreshes the timer from partial Working heartbeat fragments", async () => {
        observeTerminalOutputForCodexApproval("b1", "Worki\r\n");

        vi.advanceTimersByTime(3000);
        observeTerminalOutputForCodexApproval("b1", "Workin\r\n");

        vi.advanceTimersByTime(3000);
        await flushMicrotasks();
        expect(agentNotifyCommand).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);
    });

    it("does not arm from non-heartbeat output after a heartbeat pause notification clears", async () => {
        observeTerminalOutputForCodexApproval("b1", "Working...\r\n");

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);

        observeTerminalOutputForCodexApproval("b1", "Would you like to run the following command?\r\n");
        await flushMicrotasks();

        vi.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(agentNotifyCommand).toHaveBeenCalledTimes(1);
        expect(clearAgentNotificationCommand).toHaveBeenCalledWith(undefined, "codex-question:b1");
    });
});
