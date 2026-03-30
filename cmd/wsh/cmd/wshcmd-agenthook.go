// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"golang.org/x/term"
)

var agentHookCmd = &cobra.Command{
	Use:   "agenthook <agent>",
	Short: "process AI agent lifecycle hooks and send notifications",
	Long: `Process AI agent lifecycle hooks and send agent notifications to the Wave Terminal panel.

Supported agents:
  claude      Claude Code (https://claude.ai/code)
  opencode    opencode (https://opencode.ai) — primary integration via waveterm.js plugin
  codex       Codex CLI (https://developers.openai.com/codex)

Supported hook types (claude):
  stop          Agent turn completed — reads transcript and sends a completion notification
  notification  Agent notification or question hook

Supported hook types (opencode):
  event         Process a single opencode event JSON from stdin

Supported hook types (codex):
  stop            Final assistant response for a Codex session
  posttooluse     Post-tool hook (currently Bash-focused for error detection)
  userpromptsubmit Clear the active notification when the user re-engages
  run             Launch Codex through a Wave PTY proxy for best-effort question detection

Example ~/.claude/settings.json Stop hook:
  {"type": "command", "command": "wsh agenthook claude stop"}

For opencode, use the waveterm.js plugin in ~/.config/opencode/plugins/ instead of
shell hooks — the plugin receives events directly and calls wsh agentnotify.

For Codex, enable hooks in ~/.codex/config.toml and point hooks.json commands at
the codex hook handlers below. Use "wsh agenthook codex run -- codex" if you also
want best-effort question / approval notifications.`,
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

var agentHookCodexCmd = &cobra.Command{
	Use:   "codex <hook-type> [command...]",
	Short: "handle Codex CLI hooks",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "stop":
			return agentHookCodexStopRun(cmd, args)
		case "posttooluse":
			return agentHookCodexPostToolUseRun(cmd, args)
		case "userpromptsubmit":
			return agentHookCodexUserPromptSubmitRun(cmd, args)
		case "run":
			return agentHookCodexRun(cmd, args)
		default:
			return fmt.Errorf("unsupported hook type %q (supported: stop, posttooluse, userpromptsubmit, run)", args[0])
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
		return sendHookNotificationForAgent("Session complete", cwd, "completion", "opencode")
	case "session.error":
		msg := ev.Properties.Error.Message
		if msg == "" {
			msg = "Session error"
		}
		return sendHookNotificationForAgent(truncate(strings.Join(strings.Fields(msg), " "), 300), cwd, "error", "opencode")
	default:
		return fmt.Errorf("unsupported opencode event type %q (supported: session.idle, session.error)", ev.Type)
	}
}

func init() {
	rootCmd.AddCommand(agentHookCmd)
	agentHookCmd.AddCommand(agentHookClaudeCmd)
	agentHookCmd.AddCommand(agentHookOpencodeCmd)
	agentHookCmd.AddCommand(agentHookCodexCmd)
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

type codexHookInput struct {
	SessionID            string          `json:"session_id"`
	Cwd                  string          `json:"cwd"`
	TranscriptPath       string          `json:"transcript_path"`
	LastAssistantMessage string          `json:"last_assistant_message"`
	ToolName             string          `json:"tool_name"`
	ToolResponse         json.RawMessage `json:"tool_response"`
}

type codexQuestionDetector struct {
	mu       sync.Mutex
	tail     string
	lastSent time.Time
}

const (
	codexNotifyIDEnv            = "WAVE_CODEX_NOTIFYID"
	codexQuestionNotifyCooldown = 5 * time.Second
)

var (
	ansiRegexp            = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))`)
	codexExitCodeRegexp   = regexp.MustCompile(`(?i)\b(?:exit(?:ed)?(?: with)?(?: code)?|status)\s*[:=]?\s*([1-9][0-9]*)\b`)
	codexQuestionPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bapproval required\b`),
		regexp.MustCompile(`(?i)\brequires approval\b`),
		regexp.MustCompile(`(?i)\bwaiting for approval\b`),
		regexp.MustCompile(`(?i)\bwould you like to run the following command\b`),
		regexp.MustCompile(`(?i)\bwould you like to allow\b`),
		regexp.MustCompile(`(?i)\bgrant permission\b`),
		regexp.MustCompile(`(?i)\bapprove(?: this)?(?: command| action)?\b`),
		regexp.MustCompile(`(?i)\bpermission (?:required|needed)\b`),
		regexp.MustCompile(`(?i)\brequest_permissions\b`),
		regexp.MustCompile(`(?i)\bmcp elicitation\b`),
		regexp.MustCompile(`(?i)\buser input required\b`),
		regexp.MustCompile(`(?i)\byes,\s*proceed\b`),
		regexp.MustCompile(`(?i)\bdon't ask again\b`),
	}
	codexQuestionHeadlinePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bapproval required\b`),
		regexp.MustCompile(`(?i)\brequires approval\b`),
		regexp.MustCompile(`(?i)\bwaiting for approval\b`),
		regexp.MustCompile(`(?i)\bwould you like to run the following command\b`),
		regexp.MustCompile(`(?i)\bwould you like to allow\b`),
		regexp.MustCompile(`(?i)\bgrant permission\b`),
		regexp.MustCompile(`(?i)\bapprove(?: this)?(?: command| action)?\b`),
		regexp.MustCompile(`(?i)\bpermission (?:required|needed)\b`),
		regexp.MustCompile(`(?i)\brequest_permissions\b`),
		regexp.MustCompile(`(?i)\bmcp elicitation\b`),
		regexp.MustCompile(`(?i)\buser input required\b`),
	}
	codexQuestionTextPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bneed your approval\b`),
		regexp.MustCompile(`(?i)\bdo you want me to run\b`),
		regexp.MustCompile(`(?i)\bdo you want me to\b`),
		regexp.MustCompile(`(?i)\bplease confirm\b`),
		regexp.MustCompile(`(?i)\bwhat would you like me to do\b`),
		regexp.MustCompile(`(?i)\bwhich option\b`),
		regexp.MustCompile(`(?i)\bhow would you like me to proceed\b`),
		regexp.MustCompile(`(?i)\bI need your input\b`),
		regexp.MustCompile(`(?i)\bI need you to answer\b`),
		regexp.MustCompile(`(?i)\breply with a number\b`),
		regexp.MustCompile(`(?i)\bdescribe the command\b`),
	}
	codexErrorTextPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bfailed\b`),
		regexp.MustCompile(`(?i)\berror\b`),
		regexp.MustCompile(`(?i)\bunable to\b`),
		regexp.MustCompile(`(?i)\bcould not\b`),
		regexp.MustCompile(`(?i)\bnon-zero exit\b`),
		regexp.MustCompile(`(?i)\bpermission denied\b`),
		regexp.MustCompile(`(?i)\bno such file or directory\b`),
		regexp.MustCompile(`(?i)\bblocked\b`),
	}
)

// extractTranscriptText parses a Claude/Codex JSONL transcript and returns
// the best last-response text from the current turn (messages after the last
// human/user message). Prefers the last assistant text with len > 20; falls
// back to last non-empty text; returns "" if nothing useful is found.
func extractTranscriptText(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	type transcriptEntry struct {
		role string
		text string
	}
	var entries []transcriptEntry
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		role := transcriptRole(entry)
		text := normalizeNotificationMessage(transcriptText(entry))
		if role == "" && text == "" {
			continue
		}
		entries = append(entries, transcriptEntry{role: role, text: text})
	}

	// Find the last human/user message to scope the current turn.
	lastUserIdx := -1
	for i, e := range entries {
		if e.role == "human" || e.role == "user" {
			lastUserIdx = i
		}
	}

	// Collect text from assistant messages after the last user message.
	var texts []string
	for i := lastUserIdx + 1; i < len(entries); i++ {
		e := entries[i]
		if e.role != "assistant" {
			continue
		}
		if e.text != "" {
			texts = append(texts, e.text)
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

func extractClaudeTranscriptText(path string) string {
	return extractTranscriptText(path)
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
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		return transcriptText(obj)
	}
	var arr []any
	if err := json.Unmarshal(raw, &arr); err == nil {
		return transcriptText(arr)
	}
	return ""
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

func normalizeNotificationMessage(s string) string {
	return truncate(strings.Join(strings.Fields(strings.TrimSpace(s)), " "), 300)
}

func transcriptRole(entry map[string]any) string {
	for _, key := range []string{"role", "type"} {
		if v, ok := entry[key].(string); ok {
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "assistant":
				return "assistant"
			case "user", "human":
				return "user"
			}
		}
	}
	for _, key := range []string{"message", "item", "event", "entry"} {
		if nested, ok := entry[key].(map[string]any); ok {
			if role := transcriptRole(nested); role != "" {
				return role
			}
		}
	}
	return ""
}

func transcriptText(v any) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		return val
	case []any:
		var parts []string
		for _, item := range val {
			part := strings.TrimSpace(transcriptText(item))
			if part != "" {
				parts = append(parts, part)
			}
		}
		return strings.Join(parts, " ")
	case map[string]any:
		for _, key := range []string{"text", "output_text"} {
			if s, ok := val[key].(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
		var parts []string
		for _, key := range []string{"content", "message", "output", "result"} {
			if sub, ok := val[key]; ok {
				part := strings.TrimSpace(transcriptText(sub))
				if part != "" {
					parts = append(parts, part)
				}
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
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

// sendHookNotification sends an AgentNotification for Claude Code hooks.
func sendHookNotification(message, cwd, status string) error {
	return sendHookNotificationForAgent(message, cwd, status, "claude")
}

func sendHookNotificationForAgent(message, cwd, status, agent string) error {
	return sendHookNotificationForAgentWithNotifyID(message, cwd, status, agent, "")
}

func sendHookNotificationForAgentWithNotifyID(message, cwd, status, agent, notifyId string) error {
	if message == "" {
		message = "done"
	}
	message = normalizeNotificationMessage(message)

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

	if notifyId == "" && orefStr != "" {
		notifyId = orefStr
	}
	if notifyId == "" {
		id, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generating notify id: %v", err)
		}
		notifyId = id.String()
	}

	notification := baseds.AgentNotification{
		NotifyId: notifyId,
		ORef:     orefStr,
		Agent:    agent,
		Status:   status,
		Message:  message,
		WorkDir:  workDir,
		Branch:   branch,
		Worktree: worktree,
	}

	return wshclient.AgentNotifyCommand(RpcClient, notification, &wshrpc.RpcOpts{NoResponse: true})
}

func sendHookNotificationWithBeep(message, cwd, status string) error {
	if err := sendHookNotificationWithBeepForAgentWithNotifyID(message, cwd, status, "claude", ""); err != nil {
		return err
	}
	return nil
}

func sendHookNotificationWithBeepForAgentWithNotifyID(message, cwd, status, agent, notifyId string) error {
	if err := sendHookNotificationForAgentWithNotifyID(message, cwd, status, agent, notifyId); err != nil {
		return err
	}
	return wshclient.ElectronSystemBellCommand(RpcClient, &wshrpc.RpcOpts{Route: "electron"})
}

func clearHookNotification(notifyID string) error {
	if notifyID == "" {
		return nil
	}
	return wshclient.ClearAgentNotificationCommand(RpcClient, notifyID, &wshrpc.RpcOpts{NoResponse: true})
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
		message = extractTranscriptText(transcriptPath)
	}

	err = sendHookNotification(message, cwd, "completion")
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	return nil
}

func readCodexHookInput() (codexHookInput, string, error) {
	stdinData, err := io.ReadAll(WrappedStdin)
	if err != nil {
		return codexHookInput{}, "", fmt.Errorf("reading stdin: %v", err)
	}
	var hookInput codexHookInput
	if len(bytes.TrimSpace(stdinData)) > 0 {
		if err := json.Unmarshal(stdinData, &hookInput); err != nil {
			return codexHookInput{}, "", fmt.Errorf("parsing codex hook JSON: %v", err)
		}
	}
	cwd := hookInput.Cwd
	if cwd == "" {
		cwd = os.Getenv("PWD")
	}
	return hookInput, cwd, nil
}

func codexNotifyID(sessionID string) string {
	if notifyID := strings.TrimSpace(os.Getenv(codexNotifyIDEnv)); notifyID != "" {
		return notifyID
	}
	return strings.TrimSpace(sessionID)
}

func classifyCodexStopStatus(message string) string {
	message = normalizeNotificationMessage(message)
	if message == "" {
		return ""
	}
	return "completion"
}

func decodeNestedJSON(value any) any {
	s, ok := value.(string)
	if !ok {
		return value
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return ""
	}
	var nested any
	if json.Unmarshal([]byte(trimmed), &nested) == nil {
		return nested
	}
	return trimmed
}

func parseCodexToolResponse(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return strings.TrimSpace(string(raw))
	}
	return decodeNestedJSON(v)
}

func findNumericField(v any, keys ...string) (int, bool) {
	switch val := v.(type) {
	case map[string]any:
		for _, key := range keys {
			if field, ok := val[key]; ok {
				switch n := field.(type) {
				case float64:
					return int(n), true
				case int:
					return n, true
				case string:
					if parsed, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
						return parsed, true
					}
				}
			}
		}
		for _, field := range val {
			if n, ok := findNumericField(field, keys...); ok {
				return n, true
			}
		}
	case []any:
		for _, field := range val {
			if n, ok := findNumericField(field, keys...); ok {
				return n, true
			}
		}
	}
	return 0, false
}

func findBoolField(v any, keys ...string) (bool, bool) {
	switch val := v.(type) {
	case map[string]any:
		for _, key := range keys {
			if field, ok := val[key]; ok {
				if b, ok := field.(bool); ok {
					return b, true
				}
			}
		}
		for _, field := range val {
			if b, ok := findBoolField(field, keys...); ok {
				return b, true
			}
		}
	case []any:
		for _, field := range val {
			if b, ok := findBoolField(field, keys...); ok {
				return b, true
			}
		}
	}
	return false, false
}

func findStringField(v any, keys ...string) string {
	switch val := v.(type) {
	case string:
		return normalizeNotificationMessage(val)
	case map[string]any:
		for _, key := range keys {
			if field, ok := val[key]; ok {
				if s := findStringField(field); s != "" {
					return s
				}
			}
		}
		for _, field := range val {
			if s := findStringField(field, keys...); s != "" {
				return s
			}
		}
	case []any:
		for _, field := range val {
			if s := findStringField(field, keys...); s != "" {
				return s
			}
		}
	}
	return ""
}

func extractCodexFailureMessage(toolResponse any, exitCode int) string {
	message := findStringField(toolResponse, "stderr", "error", "message", "output", "stdout")
	if message == "" {
		return fmt.Sprintf("Bash command failed with exit code %d", exitCode)
	}
	return message
}

func classifyCodexPostToolUse(toolName string, toolResponse any) (string, bool) {
	if !strings.EqualFold(strings.TrimSpace(toolName), "Bash") {
		return "", false
	}
	if exitCode, ok := findNumericField(toolResponse, "exit_code", "exitCode", "status_code"); ok && exitCode != 0 {
		return extractCodexFailureMessage(toolResponse, exitCode), true
	}
	if success, ok := findBoolField(toolResponse, "success", "ok"); ok && !success {
		message := findStringField(toolResponse, "stderr", "error", "message", "output")
		if message == "" {
			message = "Bash command failed"
		}
		return message, true
	}
	if text, ok := toolResponse.(string); ok {
		text = normalizeNotificationMessage(text)
		if text == "" {
			return "", false
		}
		if matches := codexExitCodeRegexp.FindStringSubmatch(text); len(matches) == 2 {
			return text, true
		}
		for _, re := range codexErrorTextPatterns {
			if re.MatchString(text) {
				return text, true
			}
		}
	}
	return "", false
}

func stripANSIEscapes(s string) string {
	return ansiRegexp.ReplaceAllString(s, "")
}

func isCodexRunReadDone(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "input/output error")
}

func (d *codexQuestionDetector) Observe(chunk []byte) (string, bool) {
	cleaned := stripANSIEscapes(string(chunk))
	if cleaned == "" {
		return "", false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.tail += cleaned
	if len(d.tail) > 4096 {
		d.tail = d.tail[len(d.tail)-4096:]
	}
	now := time.Now()
	if !d.lastSent.IsZero() && now.Sub(d.lastSent) < codexQuestionNotifyCooldown {
		return "", false
	}
	for _, re := range codexQuestionPatterns {
		if re.MatchString(d.tail) {
			msg := codexQuestionMessage(d.tail)
			d.lastSent = now
			d.tail = "" // reset so stale approval text can't re-trigger after cooldown
			return msg, true
		}
	}
	return "", false
}

func codexQuestionMessage(tail string) string {
	lines := strings.Split(tail, "\n")
	for _, line := range lines {
		line = normalizeNotificationMessage(line)
		if line == "" {
			continue
		}
		for _, re := range codexQuestionHeadlinePatterns {
			if re.MatchString(line) {
				return line
			}
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := normalizeNotificationMessage(lines[i])
		if line == "" {
			continue
		}
		for _, re := range codexQuestionPatterns {
			if re.MatchString(line) {
				return line
			}
		}
	}
	return "Codex is waiting for input or approval"
}

func codexRunNotifyID() string {
	if notifyID := codexNotifyID(""); notifyID != "" {
		return notifyID
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Sprintf("codex-%d", time.Now().UnixNano())
	}
	return id.String()
}

func agentHookCodexStopRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-stop", rtnErr == nil)
	}()

	hookInput, cwd, err := readCodexHookInput()
	if err != nil {
		return err
	}

	message := normalizeNotificationMessage(hookInput.LastAssistantMessage)
	if len([]rune(message)) <= 20 && hookInput.TranscriptPath != "" {
		message = extractTranscriptText(hookInput.TranscriptPath)
	}
	status := classifyCodexStopStatus(message)
	if status == "" {
		return nil
	}
	if err := sendHookNotificationForAgentWithNotifyID(message, cwd, status, "codex", codexNotifyID(hookInput.SessionID)); err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}
	return nil
}

func agentHookCodexPostToolUseRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-posttooluse", rtnErr == nil)
	}()

	hookInput, cwd, err := readCodexHookInput()
	if err != nil {
		return err
	}

	toolResponse := parseCodexToolResponse(hookInput.ToolResponse)
	message, ok := classifyCodexPostToolUse(hookInput.ToolName, toolResponse)
	if !ok {
		return nil
	}
	if err := sendHookNotificationForAgentWithNotifyID(message, cwd, "error", "codex", codexNotifyID(hookInput.SessionID)); err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}
	return nil
}

func agentHookCodexUserPromptSubmitRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-userpromptsubmit", rtnErr == nil)
	}()

	hookInput, _, err := readCodexHookInput()
	if err != nil {
		return err
	}
	if err := clearHookNotification(codexNotifyID(hookInput.SessionID)); err != nil {
		return fmt.Errorf("clearing agent notification: %v", err)
	}
	return nil
}

func agentHookCodexRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-run", rtnErr == nil)
	}()

	runArgs := args[1:]
	if len(runArgs) == 0 {
		runArgs = []string{"codex"}
	}
	binPath, err := exec.LookPath(runArgs[0])
	if err != nil {
		return fmt.Errorf("finding codex executable %q: %v", runArgs[0], err)
	}

	notifyID := codexRunNotifyID()
	proxyCmd := exec.Command(binPath, runArgs[1:]...)
	proxyCmd.Stderr = nil
	proxyCmd.Stdout = nil
	proxyCmd.Stdin = nil
	proxyCmd.Env = append(os.Environ(), codexNotifyIDEnv+"="+notifyID)

	ptmx, err := pty.Start(proxyCmd)
	if err != nil {
		return fmt.Errorf("starting codex pty: %v", err)
	}
	defer ptmx.Close()

	if stdinFd := int(os.Stdin.Fd()); term.IsTerminal(stdinFd) {
		if size, err := pty.GetsizeFull(os.Stdin); err == nil {
			_ = pty.Setsize(ptmx, size)
		}
	}

	var oldState *term.State
	if stdinFd := int(os.Stdin.Fd()); term.IsTerminal(stdinFd) {
		oldState, err = term.MakeRaw(stdinFd)
		if err != nil {
			return fmt.Errorf("setting terminal raw mode: %v", err)
		}
		defer func() {
			_ = term.Restore(stdinFd, oldState)
		}()
	}

	go func() {
		_, _ = io.Copy(ptmx, os.Stdin)
	}()

	detector := &codexQuestionDetector{}
	readBuf := make([]byte, 4096)
	for {
		n, readErr := ptmx.Read(readBuf)
		if n > 0 {
			chunk := readBuf[:n]
			if _, err := os.Stdout.Write(chunk); err != nil {
				return fmt.Errorf("writing codex output: %v", err)
			}
			if message, matched := detector.Observe(chunk); matched {
				if err := sendHookNotificationWithBeepForAgentWithNotifyID(message, os.Getenv("PWD"), "question", "codex", notifyID); err != nil {
					return fmt.Errorf("sending agent notification: %v", err)
				}
			}
		}
		if readErr == nil {
			continue
		}
		if isCodexRunReadDone(readErr) {
			break
		}
		return fmt.Errorf("reading codex output: %v", readErr)
	}

	// Replace any pending question notification with completion now that the session has ended.
	_ = sendHookNotificationForAgentWithNotifyID("Session complete", os.Getenv("PWD"), "completion", "codex", notifyID)

	waitErr := proxyCmd.Wait()
	if waitErr == nil {
		return nil
	}
	return waitErr
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
