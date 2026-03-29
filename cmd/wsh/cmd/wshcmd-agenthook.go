// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var agentHookCmd = &cobra.Command{
	Use:   "agenthook <agent>",
	Short: "process AI agent lifecycle hooks and send notifications",
	Long: `Process AI agent lifecycle hooks and send agent notifications to the Wave Terminal panel.

Supported agents:
  claude      Claude Code (https://claude.ai/code)
  opencode    opencode (https://opencode.ai) — primary integration via waveterm.js plugin

Supported hook types (claude):
  stop          Agent turn completed — reads transcript and sends a completion notification
  notification  Agent notification or question hook

Supported hook types (opencode):
  event         Process a single opencode event JSON from stdin

Example ~/.claude/settings.json Stop hook:
  {"type": "command", "command": "wsh agenthook claude stop"}

For opencode, use the waveterm.js plugin in ~/.config/opencode/plugins/ instead of
shell hooks — the plugin receives events directly and calls wsh agentnotify.`,
}

var agentHookClaudeCmd = &cobra.Command{
	Use:   "claude <hook-type>",
	Short: "handle Claude Code hooks",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "stop":
			return agentHookClaudeStopRun(cmd, args)
		case "notification":
			return agentHookClaudeNotificationRun(cmd, args)
		default:
			return fmt.Errorf("unsupported hook type %q (supported: stop, notification)", args[0])
		}
	},
	PreRunE: preRunSetupRpcClient,
}

var agentHookOpencodeCmd = &cobra.Command{
	Use:   "opencode <hook-type>",
	Short: "handle opencode hooks",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "event":
			return agentHookOpencodeEventRun(cmd, args)
		default:
			return fmt.Errorf("unsupported hook type %q (supported: event)", args[0])
		}
	},
	PreRunE: preRunSetupRpcClient,
}

// opencodeEventInput is the JSON structure for a single opencode event.
type opencodeEventInput struct {
	Type       string             `json:"type"`
	Properties opencodeEventProps `json:"properties"`
}

type opencodeEventProps struct {
	SessionID string `json:"sessionID"`
	Info      struct {
		Title string `json:"title"`
	} `json:"info"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func agentHookOpencodeEventRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-opencode-event", rtnErr == nil)
	}()

	stdinData, err := io.ReadAll(WrappedStdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %v", err)
	}

	var ev opencodeEventInput
	if err := json.Unmarshal(stdinData, &ev); err != nil {
		return fmt.Errorf("parsing opencode event JSON: %v", err)
	}

	cwd := os.Getenv("PWD")

	switch ev.Type {
	case "session.idle":
		return sendHookNotification("Session complete", cwd, "completion")
	case "session.error":
		msg := ev.Properties.Error.Message
		if msg == "" {
			msg = "Session error"
		}
		return sendHookNotification(truncate(strings.Join(strings.Fields(msg), " "), 300), cwd, "error")
	default:
		return fmt.Errorf("unsupported opencode event type %q (supported: session.idle, session.error)", ev.Type)
	}
}

func init() {
	rootCmd.AddCommand(agentHookCmd)
	agentHookCmd.AddCommand(agentHookClaudeCmd)
	agentHookCmd.AddCommand(agentHookOpencodeCmd)
}

// claudeHookInput is the JSON structure Claude Code sends on stdin for all hooks.
type claudeHookInput struct {
	TranscriptPath       string          `json:"transcript_path"`
	TranscriptPath2      string          `json:"transcriptPath"` // alternate camelCase key
	Cwd                  string          `json:"cwd"`
	WorkingDir           string          `json:"working_directory"` // alternate key
	LastAssistantMessage string          `json:"last_assistant_message"`
	Message              string          `json:"message"`
	ToolInput            json.RawMessage `json:"tool_input"`
}

// claudeTranscriptEntry is one line of the Claude Code JSONL transcript.
type claudeTranscriptEntry struct {
	Type    string `json:"type"` // "human" or "assistant"
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// claudeContentBlock is one element of a content array.
type claudeContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// extractClaudeTranscriptText parses a Claude Code JSONL transcript and returns
// the best last-response text from the current turn (messages after the last
// human/user message). Prefers the last assistant text with len > 20; falls
// back to last non-empty text; returns "" if nothing useful is found.
func extractClaudeTranscriptText(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var entries []claudeTranscriptEntry
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry claudeTranscriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		entries = append(entries, entry)
	}

	// Find the last human/user message to scope the current turn.
	lastUserIdx := -1
	for i, e := range entries {
		if e.Type == "human" || e.Message.Role == "user" {
			lastUserIdx = i
		}
	}

	// Collect text from assistant messages after the last user message.
	var texts []string
	for i := lastUserIdx + 1; i < len(entries); i++ {
		e := entries[i]
		if e.Type != "assistant" && e.Message.Role != "assistant" {
			continue
		}
		text := extractContentText(e.Message.Content)
		text = strings.Join(strings.Fields(text), " ") // collapse whitespace
		if text != "" {
			texts = append(texts, text)
		}
	}

	if len(texts) == 0 {
		return ""
	}

	// Prefer last text with substantial length (>20 chars) to skip brief wrap-ups
	// like "Task complete". Fall back to the last non-empty text.
	for i := len(texts) - 1; i >= 0; i-- {
		if len(texts[i]) > 20 {
			return truncate(texts[i], 300)
		}
	}
	return truncate(texts[len(texts)-1], 300)
}

// extractContentText extracts plain text from a content field that is either a
// JSON string or an array of content blocks.
func extractContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// Try string first.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	// Try array of content blocks.
	var blocks []claudeContentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, " ")
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

// runGitCmd runs a git command in the given directory and returns trimmed output.
func runGitCmd(dir string, args ...string) string {
	if dir == "" {
		return ""
	}
	fullArgs := append([]string{"-C", dir}, args...)
	out, err := exec.Command("git", fullArgs...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// sendHookNotification sends a completion AgentNotification.
func sendHookNotification(message, cwd, status string) error {
	if message == "" {
		message = "done"
	}

	workDir := cwd
	if workDir == "" {
		workDir = os.Getenv("PWD")
	}

	branch := runGitCmd(workDir, "branch", "--show-current")
	worktree := runGitCmd(workDir, "rev-parse", "--show-toplevel")

	oref, _ := resolveBlockArg()
	orefStr := ""
	if oref != nil {
		orefStr = oref.String()
	}

	var notifyId string
	if orefStr != "" {
		notifyId = orefStr
	} else {
		id, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generating notify id: %v", err)
		}
		notifyId = id.String()
	}

	notification := baseds.AgentNotification{
		NotifyId: notifyId,
		ORef:     orefStr,
		Status:   status,
		Message:  message,
		WorkDir:  workDir,
		Branch:   branch,
		Worktree: worktree,
	}

	return wshclient.AgentNotifyCommand(RpcClient, notification, &wshrpc.RpcOpts{NoResponse: true})
}

func sendHookNotificationWithBeep(message, cwd, status string) error {
	if err := sendHookNotification(message, cwd, status); err != nil {
		return err
	}
	return wshclient.ElectronSystemBellCommand(RpcClient, &wshrpc.RpcOpts{Route: "electron"})
}

// readClaudeHookInput reads and parses the hook payload from stdin.
func readClaudeHookInput() (claudeHookInput, string, error) {
	stdinData, err := io.ReadAll(WrappedStdin)
	if err != nil {
		return claudeHookInput{}, "", fmt.Errorf("reading stdin: %v", err)
	}
	var hookInput claudeHookInput
	_ = json.Unmarshal(stdinData, &hookInput)

	cwd := hookInput.Cwd
	if cwd == "" {
		cwd = hookInput.WorkingDir
	}
	if cwd == "" {
		cwd = os.Getenv("PWD")
	}
	return hookInput, cwd, nil
}

func agentHookClaudeStopRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-stop", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	// Resolve transcript path (try both field names).
	transcriptPath := hookInput.TranscriptPath
	if transcriptPath == "" {
		transcriptPath = hookInput.TranscriptPath2
	}

	// Claude Code provides last_assistant_message directly in the hook payload.
	// Fall back to transcript parsing if it's absent or too short.
	message := strings.TrimSpace(hookInput.LastAssistantMessage)
	if len([]rune(message)) > 20 {
		message = truncate(strings.Join(strings.Fields(message), " "), 300)
	} else if transcriptPath != "" {
		message = extractClaudeTranscriptText(transcriptPath)
	}

	err = sendHookNotification(message, cwd, "completion")
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	return nil
}

func agentHookClaudeNotificationRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-notification", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	// Extract the notification message. Claude Code puts it in `message` for
	// Notification hooks. For PreToolUse/AskUserQuestion it's in
	// tool_input.questions[0].question (array) or tool_input.question (string).
	message := strings.TrimSpace(hookInput.Message)
	if message == "" && len(hookInput.ToolInput) > 0 {
		var toolInput struct {
			Question  string `json:"question"`
			Prompt    string `json:"prompt"`
			Questions []struct {
				Header   string `json:"header"`
				Question string `json:"question"`
			} `json:"questions"`
		}
		if json.Unmarshal(hookInput.ToolInput, &toolInput) == nil {
			switch {
			case len(toolInput.Questions) > 0 && toolInput.Questions[0].Question != "":
				q := toolInput.Questions[0]
				if q.Header != "" {
					message = q.Header + ": " + q.Question
				} else {
					message = q.Question
				}
			case toolInput.Question != "":
				message = toolInput.Question
			case toolInput.Prompt != "":
				message = toolInput.Prompt
			}
		}
	}

	message = truncate(strings.Join(strings.Fields(message), " "), 300)

	err = sendHookNotificationWithBeep(message, cwd, "question")
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	return nil
}
