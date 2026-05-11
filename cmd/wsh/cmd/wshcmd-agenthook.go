// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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
  codex       Codex CLI (https://developers.openai.com/codex)

Supported hook types (claude):
  stop          Agent turn completed — reads transcript and sends a completion notification
  pretooluse    Before each tool use — sends an intermediate progress notification
  notification  Agent notification or question hook
  terminate     Call on Claude session exit to clear the notification badge

Supported hook types (opencode):
  event         Process a single opencode event JSON from stdin

Supported hook types (codex):
  stop              Final assistant response for a Codex session
  posttooluse       Post-tool hook (currently Bash-focused for error detection)
  userpromptsubmit  Clear the active notification when the user re-engages
  notification      Agent notification or question hook

Example ~/.claude/settings.json Stop hook:
  {"type": "command", "command": "wsh agenthook claude stop"}

For opencode, use the waveterm.js plugin in ~/.config/opencode/plugins/ instead of
shell hooks — the plugin receives events directly and calls wsh agentnotify.

For Codex, enable hooks in ~/.codex/config.toml and point hooks.json commands at
the codex hook handlers below.`,
}

var agentHookClaudeCmd = &cobra.Command{
	Use:   "claude <hook-type>",
	Short: "handle Claude Code hooks",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "stop":
			return agentHookClaudeStopRun(cmd, args)
		case "stopfailure":
			return agentHookClaudeStopFailureRun(cmd, args)
		case "pretooluse":
			return agentHookClaudePreToolUseRun(cmd, args)
		case "posttooluse":
			return agentHookClaudePostToolUseRun(cmd, args)
		case "notification":
			return agentHookClaudeNotificationRun(cmd, args)
		case "sessionstart":
			return agentHookClaudeSessionStartRun(cmd, args)
		case "terminate":
			return agentHookClaudeTerminateRun(cmd, args)
		default:
			return fmt.Errorf("unsupported hook type %q (supported: stop, stopfailure, pretooluse, posttooluse, notification, sessionstart, terminate)", args[0])
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
		case "notification":
			return agentHookCodexNotificationRun(cmd, args)
		default:
			return fmt.Errorf("unsupported hook type %q (supported: stop, posttooluse, userpromptsubmit, notification)", args[0])
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
	Error                string          `json:"error"`
	ErrorDetails         string          `json:"error_details"`
	ToolName             string          `json:"tool_name"`
	Source               string          `json:"source"` // SessionStart: "startup"|"resume"|"clear"|"compact"
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
	Message              string          `json:"message"`
}

const (
	agentLifecycleTerminal     = "terminal"
	agentLifecycleIntermediate = "intermediate"
)

var (
	codexExitCodeRegexp    = regexp.MustCompile(`(?i)\b(?:exit(?:ed)?(?: with)?(?: code)?|status)\s*[:=]?\s*([1-9][0-9]*)\b`)
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
	codexTerminalErrorPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^(?:i(?:'m| am)?\s+)?(?:cannot|can't|could not|couldn't|unable to|was not able to|wasn't able to)\b`),
		regexp.MustCompile(`(?i)^(?:the )?(?:task|request|operation)\s+(?:failed|could not be completed)\b`),
		regexp.MustCompile(`(?i)^(?:permission denied|no such file or directory)\b`),
	}
	codexCompletionTextPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(?:done|complete|completed|implemented|fixed|resolved|updated|succeeded|successfully|passes|passes now|no errors found|finished)\b`),
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

// trimToFirstSentence cuts s at the first sentence-ending punctuation (a period
// followed by whitespace or end-of-string) or the first newline, but only if
// the resulting prefix has at least minWords words. Otherwise it scans past
// the boundary and tries the next one. Returns the original string if no
// suitable boundary is found.
func trimToFirstSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	const minWords = 7
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		isEnd := false
		switch {
		case c == '\n':
			isEnd = true
		case c == '.':
			if i+1 == len(runes) {
				isEnd = true
			} else {
				next := runes[i+1]
				if next == ' ' || next == '\t' || next == '\n' || next == '\r' {
					isEnd = true
				}
			}
		}
		if !isEnd {
			continue
		}
		candidate := strings.TrimSpace(string(runes[:i+1]))
		if len(strings.Fields(candidate)) >= minWords {
			return candidate
		}
	}
	return s
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

// linkedWorktreeMainRepo returns the main repo root when dir is inside a linked
// worktree, and "" when it is the main working tree or not a git repo.
// Detection: --git-dir and --git-common-dir point to different locations only
// for linked worktrees (the linked worktree gets its own per-worktree git dir
// under <main>/.git/worktrees/<name>).
func linkedWorktreeMainRepo(dir string) string {
	gitDir := runGitCmd(dir, "rev-parse", "--git-dir")
	commonDir := runGitCmd(dir, "rev-parse", "--git-common-dir")
	if gitDir == "" || commonDir == "" || gitDir == commonDir {
		return ""
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(dir, commonDir)
	}
	return filepath.Dir(filepath.Clean(commonDir))
}

// sendHookNotification sends an AgentNotification for Claude Code hooks.
func sendHookNotification(message, cwd, status string) error {
	return sendHookNotificationForAgent(message, cwd, status, "claude")
}

func sendHookNotificationForAgent(message, cwd, status, agent string) error {
	return sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, status, agent, "", agentLifecycleTerminal)
}

func sendHookNotificationForAgentWithNotifyID(message, cwd, status, agent, notifyId string) error {
	return sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, status, agent, notifyId, agentLifecycleTerminal)
}

func sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, status, agent, notifyId, lifecycle string) error {
	if message == "" {
		message = "done"
	}
	message = normalizeNotificationMessage(message)

	workDir := cwd
	if workDir == "" {
		workDir = os.Getenv("PWD")
	}

	branch := runGitCmd(workDir, "branch", "--show-current")
	worktree := ""
	if mainRepo := linkedWorktreeMainRepo(workDir); mainRepo != "" {
		worktree = branch // worktree branch name (before switching to main)
		workDir = mainRepo
		branch = runGitCmd(mainRepo, "branch", "--show-current")
	}
	if homeDir := os.Getenv("HOME"); homeDir != "" && strings.HasPrefix(workDir, homeDir+"/") {
		workDir = "~/" + workDir[len(homeDir)+1:]
	}

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
		NotifyId:  notifyId,
		ORef:      orefStr,
		Agent:     agent,
		Status:    status,
		Lifecycle: lifecycle,
		Message:   message,
		WorkDir:   workDir,
		Branch:    branch,
		Worktree:  worktree,
	}

	return wshclient.AgentNotifyCommand(RpcClient, notification, &wshrpc.RpcOpts{NoResponse: true})
}

func sendHookNotificationWithBeep(message, cwd, status string) error {
	if err := sendHookNotificationWithBeepForAgentWithNotifyIDLifecycle(message, cwd, status, "claude", "", agentLifecycleTerminal); err != nil {
		return err
	}
	return nil
}

func sendHookNotificationWithBeepForAgentWithNotifyID(message, cwd, status, agent, notifyId string) error {
	return sendHookNotificationWithBeepForAgentWithNotifyIDLifecycle(message, cwd, status, agent, notifyId, agentLifecycleTerminal)
}

func sendHookNotificationWithBeepForAgentWithNotifyIDLifecycle(message, cwd, status, agent, notifyId, lifecycle string) error {
	if err := sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, status, agent, notifyId, lifecycle); err != nil {
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

// extractClaudeSessionName scans the Claude transcript JSONL and returns the
// most recent session label, reading both "agent-name" (kebab) and "ai-title"
// (often sentence-style on the first turn, then kebab) entries. Whichever
// appears later in the file wins. Returns "" if the transcript is missing or
// has no label entries yet.
//
// Why both: agent-name only starts appearing after many turns into a session
// (line ~170 in observed transcripts), while ai-title shows up after the first
// turn (line ~10). Reading only agent-name leaves new sessions without a title
// for a long time.
func extractClaudeSessionName(transcriptPath string) string {
	if transcriptPath == "" {
		return ""
	}
	f, err := os.Open(transcriptPath)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	last := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry struct {
			Type      string `json:"type"`
			AgentName string `json:"agentName"`
			AiTitle   string `json:"aiTitle"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		switch entry.Type {
		case "agent-name":
			if entry.AgentName != "" {
				last = entry.AgentName
			}
		case "ai-title":
			if entry.AiTitle != "" {
				last = entry.AiTitle
			}
		}
	}
	return last
}

// sendClaudeHookNotificationWithTopic builds a Claude AgentNotification with
// the given topic, sends it, and optionally rings the system bell.
func sendClaudeHookNotificationWithTopic(message, cwd, status, notifyId, lifecycle, topic string, beep bool) error {
	if message == "" {
		message = "done"
	}
	message = trimToFirstSentence(message)
	message = normalizeNotificationMessage(message)

	workDir := cwd
	if workDir == "" {
		workDir = os.Getenv("PWD")
	}
	branch := runGitCmd(workDir, "branch", "--show-current")
	worktree := ""
	if mainRepo := linkedWorktreeMainRepo(workDir); mainRepo != "" {
		worktree = branch // worktree branch name (before switching to main)
		workDir = mainRepo
		branch = runGitCmd(mainRepo, "branch", "--show-current")
	}
	if homeDir := os.Getenv("HOME"); homeDir != "" && strings.HasPrefix(workDir, homeDir+"/") {
		workDir = "~/" + workDir[len(homeDir)+1:]
	}

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
	if lifecycle == "" {
		lifecycle = agentLifecycleTerminal
	}

	notification := baseds.AgentNotification{
		NotifyId:  notifyId,
		ORef:      orefStr,
		Agent:     "claude",
		Status:    status,
		Lifecycle: lifecycle,
		Message:   message,
		Topic:     topic,
		WorkDir:   workDir,
		Branch:    branch,
		Worktree:  worktree,
	}

	if err := wshclient.AgentNotifyCommand(RpcClient, notification, &wshrpc.RpcOpts{NoResponse: true}); err != nil {
		return err
	}
	if beep {
		return wshclient.ElectronSystemBellCommand(RpcClient, &wshrpc.RpcOpts{Route: "electron"})
	}
	return nil
}

// clearFrameTextForBlock removes the frame:text metadata key on the current
// terminal block, so the default live-cwd rendering takes over.
func clearFrameTextForBlock() {
	oref, err := resolveBlockArg()
	if err != nil || oref == nil {
		return
	}
	_ = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: *oref,
		Meta: waveobj.MetaMapType{"frame:text": nil},
	}, &wshrpc.RpcOpts{NoResponse: true})
}

// setSessionTopicForBlock sets the terminal block header to "<cwd> [<topic>]".
// If topic is empty, leaves frame:text unset so the default live-cwd rendering takes over.
func setSessionTopicForBlock(cwd, topic string) {
	if topic == "" {
		return
	}
	oref, err := resolveBlockArg()
	if err != nil || oref == nil {
		return
	}
	displayCwd := cwd
	if home := os.Getenv("HOME"); home != "" && (cwd == home || strings.HasPrefix(cwd, home+"/")) {
		displayCwd = "~" + cwd[len(home):]
	}
	text := strings.TrimSpace(displayCwd + " (" + topic + ")")
	_ = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: *oref,
		Meta: waveobj.MetaMapType{"frame:text": text},
	}, &wshrpc.RpcOpts{NoResponse: true})
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

	topic := ""
	if transcriptPath != "" {
		topic = extractClaudeSessionName(transcriptPath)
	}

	err = sendClaudeHookNotificationWithTopic(message, cwd, "completion", "", "", topic, false)
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	setSessionTopicForBlock(cwd, topic)

	return nil
}

func agentHookClaudeSessionStartRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-sessionstart", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	transcriptPath := hookInput.TranscriptPath
	if transcriptPath == "" {
		transcriptPath = hookInput.TranscriptPath2
	}

	switch hookInput.Source {
	case "startup":
		clearFrameTextForBlock()
		_ = sendClaudeHookNotificationWithTopic("Ready", cwd, "completion", "", "", extractClaudeSessionName(transcriptPath), false)
	case "clear":
		clearFrameTextForBlock()
		_ = sendClaudeHookNotificationWithTopic("Cleared", cwd, "info", "", "", "", false)
	case "resume":
		setSessionTopicForBlock(cwd, extractClaudeSessionName(transcriptPath))
		_ = sendClaudeHookNotificationWithTopic("Ready", cwd, "completion", "", "", extractClaudeSessionName(transcriptPath), false)
	}
	// "compact" or unrecognized: leave existing frame:text in place

	return nil
}

func agentHookClaudeTerminateRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-terminate", rtnErr == nil)
	}()

	oref, _ := resolveBlockArg()
	if oref == nil {
		return nil
	}
	return clearHookNotification(oref.String())
}

func agentHookClaudeStopFailureRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-stopfailure", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	message := strings.TrimSpace(hookInput.LastAssistantMessage)
	if message == "" {
		message = strings.TrimSpace(hookInput.ErrorDetails)
	}
	if message == "" {
		message = strings.TrimSpace(hookInput.Error)
	}
	if message == "" {
		message = "Task failed"
	}
	message = normalizeNotificationMessage(message)

	transcriptPath := hookInput.TranscriptPath
	if transcriptPath == "" {
		transcriptPath = hookInput.TranscriptPath2
	}
	topic := ""
	if transcriptPath != "" {
		topic = extractClaudeSessionName(transcriptPath)
	}

	if err := sendClaudeHookNotificationWithTopic(message, cwd, "error", "", "", topic, true); err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	setSessionTopicForBlock(cwd, topic)

	return nil
}

func extractToolProgressMessage(toolName string, toolInput json.RawMessage) string {
	if toolName == "" {
		return "working"
	}
	var fields map[string]json.RawMessage
	if len(toolInput) == 0 || json.Unmarshal(toolInput, &fields) != nil {
		return toolName
	}
	extractStr := func(key string) string {
		raw, ok := fields[key]
		if !ok {
			return ""
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return strings.TrimSpace(s)
	}
	var detail string
	switch strings.ToLower(toolName) {
	case "bash":
		if cmd := extractStr("command"); cmd != "" {
			detail = strings.Join(strings.Fields(cmd), " ")
		}
	case "read", "write", "edit", "multiedit", "notebookread", "notebookedit":
		detail = extractStr("file_path")
	case "glob":
		detail = extractStr("pattern")
	case "grep":
		pattern := extractStr("pattern")
		path := extractStr("path")
		if pattern != "" && path != "" {
			detail = pattern + " in " + path
		} else {
			detail = pattern
		}
	case "ls":
		detail = extractStr("path")
	case "websearch":
		detail = extractStr("query")
	case "webfetch":
		detail = extractStr("url")
	case "task":
		detail = extractStr("description")
	}
	if detail == "" {
		return toolName
	}
	return toolName + ": " + truncate(detail, 80)
}

func agentHookClaudePreToolUseRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-pretooluse", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	message := extractToolProgressMessage(hookInput.ToolName, hookInput.ToolInput)

	return sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, "info", "claude", "", agentLifecycleIntermediate)
}

func agentHookClaudePostToolUseRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-claude-posttooluse", rtnErr == nil)
	}()

	hookInput, cwd, err := readClaudeHookInput()
	if err != nil {
		return err
	}

	message := strings.TrimSpace(hookInput.Error)
	if message == "" {
		message = "Command failed"
	}
	if toolName := strings.TrimSpace(hookInput.ToolName); toolName != "" {
		message = toolName + ": " + message
	}
	message = normalizeNotificationMessage(message)

	return sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, "error", "claude", "", agentLifecycleIntermediate)
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
	return strings.TrimSpace(sessionID)
}

func hasCodexCompletionText(message string) bool {
	message = normalizeNotificationMessage(message)
	if message == "" {
		return false
	}
	for _, re := range codexCompletionTextPatterns {
		if re.MatchString(message) {
			return true
		}
	}
	return false
}

func classifyCodexStopStatus(message string) string {
	rawMessage := strings.TrimSpace(message)
	if rawMessage == "" {
		return ""
	}
	message = normalizeNotificationMessage(rawMessage)
	for _, re := range codexTerminalErrorPatterns {
		if re.MatchString(message) {
			return "error"
		}
	}
	if hasCodexCompletionText(message) {
		return "completion"
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
		return fmt.Sprintf("Tool failed with exit code %d", exitCode)
	}
	return message
}

func classifyCodexPostToolUse(toolName string, toolResponse any) (string, bool) {
	if exitCode, ok := findNumericField(toolResponse, "exit_code", "exitCode", "status_code"); ok && exitCode != 0 {
		return extractCodexFailureMessage(toolResponse, exitCode), true
	}
	if success, ok := findBoolField(toolResponse, "success", "ok"); ok && !success {
		message := findStringField(toolResponse, "stderr", "error", "message", "output")
		if message == "" {
			message = "Tool failed"
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

func agentHookCodexStopRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-stop", rtnErr == nil)
	}()

	hookInput, cwd, err := readCodexHookInput()
	if err != nil {
		return err
	}

	message := strings.TrimSpace(hookInput.LastAssistantMessage)
	if len([]rune(message)) <= 20 && hookInput.TranscriptPath != "" {
		message = extractTranscriptText(hookInput.TranscriptPath)
	}
	log.Printf(
		"agenthook-codex-stop: session=%q transcript=%q cwd=%q last_assistant_message=%q extracted_message=%q",
		hookInput.SessionID,
		hookInput.TranscriptPath,
		cwd,
		hookInput.LastAssistantMessage,
		message,
	)
	// Note: pending error promotion is handled server-side in finalizeAgentNotification.
	// The CLI process cannot see the server's in-memory pending store.
	status := classifyCodexStopStatus(message)
	log.Printf(
		"agenthook-codex-stop: session=%q classified_status=%q",
		hookInput.SessionID,
		status,
	)
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
	if err := sendHookNotificationForAgentWithNotifyIDLifecycle(message, cwd, "error", "codex", codexNotifyID(hookInput.SessionID), agentLifecycleIntermediate); err != nil {
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

func agentHookCodexNotificationRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agenthook-codex-notification", rtnErr == nil)
	}()

	hookInput, cwd, err := readCodexHookInput()
	if err != nil {
		return err
	}

	message := normalizeNotificationMessage(hookInput.Message)
	if err := sendHookNotificationWithBeepForAgentWithNotifyID(message, cwd, "question", "codex", codexNotifyID(hookInput.SessionID)); err != nil {
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

	transcriptPath := hookInput.TranscriptPath
	if transcriptPath == "" {
		transcriptPath = hookInput.TranscriptPath2
	}
	topic := ""
	if transcriptPath != "" {
		topic = extractClaudeSessionName(transcriptPath)
	}

	err = sendClaudeHookNotificationWithTopic(message, cwd, "question", "", "", topic, true)
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	setSessionTopicForBlock(cwd, topic)

	return nil
}
