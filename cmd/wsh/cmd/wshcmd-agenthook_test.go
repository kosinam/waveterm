// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassifyCodexStopStatus(t *testing.T) {
	tests := []struct {
		name            string
		message         string
		hasPendingError bool
		want            string
	}{
		{name: "empty", message: "", want: ""},
		{name: "completion", message: "Implemented the change and updated the tests.", want: "completion"},
		{name: "mentions error handling", message: "Implemented the change and fixed the error handling path.", want: "completion"},
		{name: "mentions no errors", message: "No errors found; implementation is complete.", want: "completion"},
		{name: "mentions prior blocking", message: "Blocked earlier by approval, but the task is now done.", want: "completion"},
		{name: "mentions failure in summary", message: "The build failed earlier because the file did not exist, but I fixed it and the task is complete.", want: "completion"},
		{name: "mentions approval in done text", message: "I needed approval earlier, but the task is now complete.", want: "completion"},
		{name: "pending error overrides completion text", message: "Implemented the change and updated the tests.", hasPendingError: true, want: "error"},
		{name: "question with explicit choices resolves to completion", message: "Would you like me to run the following command?\n\n1. Yes, proceed\n2. No, and tell Codex what to do differently", want: "completion"},
		{name: "question with explicit choices after a longer intro resolves to completion", message: "Would you like me to proceed with the next verification step?\n\n1. Generate a minimal end-of-turn question prompt only\n2. Summarize the exact stop-classifier patterns now in use\n3. Stop here and wait for your confirmation", want: "completion"},
		{name: "pending error still wins over end-of-turn question text", message: "Would you like me to run the following command?\n\n1. Yes, proceed\n2. No, and tell Codex what to do differently", hasPendingError: true, want: "error"},
		{name: "question without choices is not enough", message: "I need your approval before I can continue.", want: "completion"},
		{name: "terminal error", message: "I couldn't complete the task because the build failed.", want: "error"},
		{name: "terminal error with pending error", message: "I couldn't complete the task because the build failed.", hasPendingError: true, want: "error"},
		{name: "pending error with empty final message", message: "", hasPendingError: true, want: "error"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyCodexStopStatus(tc.message, tc.hasPendingError); got != tc.want {
				t.Fatalf("classifyCodexStopStatus(%q, %v) = %q, want %q", tc.message, tc.hasPendingError, got, tc.want)
			}
		})
	}
}

func TestParseCodexToolResponseNestedJSON(t *testing.T) {
	raw := []byte(`"{\"exit_code\":2,\"stderr\":\"npm test failed\"}"`)
	resp := parseCodexToolResponse(raw)
	msg, ok := classifyCodexPostToolUse("Bash", resp)
	if !ok {
		t.Fatalf("expected tool failure classification")
	}
	if !strings.Contains(msg, "npm test failed") {
		t.Fatalf("unexpected failure message: %q", msg)
	}
}

func TestClassifyCodexPostToolUseObject(t *testing.T) {
	resp := map[string]any{
		"exit_code": float64(1),
		"stderr":    "go test ./... failed",
	}
	msg, ok := classifyCodexPostToolUse("ReadFile", resp)
	if !ok {
		t.Fatalf("expected non-Bash tool failure classification")
	}
	if msg != "go test ./... failed" {
		t.Fatalf("unexpected failure message: %q", msg)
	}
}

func TestClassifyCodexPostToolUseIgnoresSuccess(t *testing.T) {
	if _, ok := classifyCodexPostToolUse("Bash", map[string]any{"exit_code": float64(0), "stdout": "ok"}); ok {
		t.Fatalf("expected successful tool to be ignored")
	}
	if _, ok := classifyCodexPostToolUse("ReadFile", map[string]any{"success": true, "message": "ok"}); ok {
		t.Fatalf("expected successful non-Bash tool to be ignored")
	}
}

func TestIsCodexTerminalQuestion(t *testing.T) {
	prompt := `Would you like me to run the following command?

1. Yes, proceed (y)
2. No, and tell Codex what to do differently (esc)`
	if !isCodexTerminalQuestion(prompt) {
		t.Fatalf("expected explicit choice prompt to classify as a question")
	}
	if isCodexTerminalQuestion("I need your approval before I can continue.") {
		t.Fatalf("did not expect a prompt without choices to classify as a question")
	}
}

func TestIsCodexTerminalQuestionApprovalSelector(t *testing.T) {
	prompt := `Would you like to run the following command?

Reason: Do you want to allow me to run curl -I https://example.com?

$ curl -I https://example.com

1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with curl -I (p)
3. No, and tell Codex what to do differently (esc)`
	if !isCodexTerminalQuestion(prompt) {
		t.Fatalf("expected approval selector prompt to classify as a question")
	}
}

func TestIsCodexTerminalQuestionLongerPrompt(t *testing.T) {
	prompt := `Would you like me to proceed with the next verification step?

1. Generate a minimal end-of-turn question prompt only
2. Summarize the exact stop-classifier patterns now in use
3. Stop here and wait for your confirmation`
	if !isCodexTerminalQuestion(prompt) {
		t.Fatalf("expected longer explicit choice prompt to classify as a question")
	}
}

func TestIsCodexTerminalQuestionChoicesOnly(t *testing.T) {
	prompt := `1. Yes, proceed
2. No, and tell Codex what to do differently`
	if !isCodexTerminalQuestion(prompt) {
		t.Fatalf("expected explicit choices alone to classify as a question")
	}
}

func TestIsCodexTerminalQuestionInlineChoices(t *testing.T) {
	prompt := `Would you like me to proceed with the next verification step? 1. Generate a minimal end-of-turn question prompt only 2. Summarize the exact stop-classifier patterns now in use 3. Stop here and wait for your confirmation`
	if !isCodexTerminalQuestion(prompt) {
		t.Fatalf("expected inline numbered choices to classify as a question")
	}
}

func TestExtractTranscriptText(t *testing.T) {
	dir := t.TempDir()
	transcriptPath := filepath.Join(dir, "codex.jsonl")
	content := strings.Join([]string{
		`{"role":"user","content":"fix the test"}`,
		`{"role":"assistant","content":[{"type":"text","text":"Done. I updated the flaky test and the suite passes now."}]}`,
	}, "\n")
	if err := os.WriteFile(transcriptPath, []byte(content), 0o600); err != nil {
		t.Fatalf("writing transcript: %v", err)
	}
	got := extractTranscriptText(transcriptPath)
	want := "Done. I updated the flaky test and the suite passes now."
	if got != want {
		t.Fatalf("extractTranscriptText() = %q, want %q", got, want)
	}
}
