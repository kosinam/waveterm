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
		name    string
		message string
		want    string
	}{
		{name: "empty", message: "", want: ""},
		{name: "completion", message: "Implemented the change and updated the tests.", want: "completion"},
		{name: "question", message: "I need your approval before I can continue.", want: "question"},
		{name: "question choices", message: "Do you want me to run a networked command that requires approval, like installing dependencies or pulling remote data? 1. Install dependencies 2. Pull latest git refs 3. Run a command that needs broader system access Reply with a number or describe the command.", want: "question"},
		{name: "error", message: "The build failed because the file does not exist.", want: "error"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyCodexStopStatus(tc.message); got != tc.want {
				t.Fatalf("classifyCodexStopStatus(%q) = %q, want %q", tc.message, got, tc.want)
			}
		})
	}
}

func TestParseCodexToolResponseNestedJSON(t *testing.T) {
	raw := []byte(`"{\"exit_code\":2,\"stderr\":\"npm test failed\"}"`)
	resp := parseCodexToolResponse(raw)
	msg, ok := classifyCodexPostToolUse("Bash", resp)
	if !ok {
		t.Fatalf("expected Bash failure classification")
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
	msg, ok := classifyCodexPostToolUse("Bash", resp)
	if !ok {
		t.Fatalf("expected Bash failure classification")
	}
	if msg != "go test ./... failed" {
		t.Fatalf("unexpected failure message: %q", msg)
	}
}

func TestClassifyCodexPostToolUseIgnoresSuccessAndOtherTools(t *testing.T) {
	if _, ok := classifyCodexPostToolUse("ReadFile", map[string]any{"exit_code": float64(1)}); ok {
		t.Fatalf("expected non-Bash tool to be ignored")
	}
	if _, ok := classifyCodexPostToolUse("Bash", map[string]any{"exit_code": float64(0), "stdout": "ok"}); ok {
		t.Fatalf("expected successful Bash tool to be ignored")
	}
}

func TestCodexQuestionDetector(t *testing.T) {
	d := &codexQuestionDetector{}
	msg, ok := d.Observe([]byte("\x1b[31mApproval required:\x1b[0m please confirm this command"))
	if !ok {
		t.Fatalf("expected question notification")
	}
	if !strings.Contains(strings.ToLower(msg), "approval required") {
		t.Fatalf("unexpected question message: %q", msg)
	}
	if _, ok := d.Observe([]byte("Approval required: repeated")); ok {
		t.Fatalf("expected detector cooldown to suppress duplicate notification")
	}
}

func TestCodexQuestionDetectorApprovalPrompt(t *testing.T) {
	d := &codexQuestionDetector{}
	prompt := `Would you like to run the following command?

Reason: Do you want to allow a harmless remote Git query?

$ git ls-remote https://github.com/git/git.git HEAD

1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with git ls-remote (p)
3. No, and tell Codex what to do differently (esc)`
	msg, ok := d.Observe([]byte(prompt))
	if !ok {
		t.Fatalf("expected approval prompt to trigger question notification")
	}
	if !strings.Contains(strings.ToLower(msg), "would you like to run the following command") {
		t.Fatalf("unexpected approval prompt message: %q", msg)
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
