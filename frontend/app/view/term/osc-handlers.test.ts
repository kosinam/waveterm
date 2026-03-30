import { describe, expect, it } from "vitest";

import { detectCodexToolApprovalPrompt, isClaudeCodeCommand, isCodexCommand } from "./osc-handlers";

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

describe("detectCodexToolApprovalPrompt", () => {
    it("matches the Codex tool approval selector", () => {
        const prompt = `Would you like to run the following command?

Reason: Do you want to allow me to run curl -I https://example.com?

$ curl -I https://example.com

1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with curl -I (p)
3. No, and tell Codex what to do differently (esc)`;
        expect(detectCodexToolApprovalPrompt(prompt)).toEqual({ command: "curl -I https://example.com" });
    });

    it("ignores generic numbered lists", () => {
        const prompt = `Would you like me to proceed with the next verification step?

1. Generate a minimal end-of-turn question prompt only
2. Summarize the exact stop-classifier patterns now in use
3. Stop here and wait for your confirmation`;
        expect(detectCodexToolApprovalPrompt(prompt)).toBeNull();
    });

    it("handles terminal escape sequences around the selector", () => {
        const prompt =
            "\u001b[33mWould you like to run the following command?\u001b[0m\r\n\r\n$ git commit -m \"x\"\r\n\r\n1. Yes, proceed (y)\r\n2. Yes, and don't ask again for commands that start with git commit (p)\r\n3. No, and tell Codex what to do differently (esc)";
        expect(detectCodexToolApprovalPrompt(prompt)).toEqual({ command: 'git commit -m "x"' });
    });
});
