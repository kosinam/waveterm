import { describe, expect, it } from "vitest";

import { isClaudeCodeCommand, isCodexCommand } from "./osc-handlers";

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
