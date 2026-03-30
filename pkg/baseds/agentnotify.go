// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package baseds

// AgentNotification represents a status notification from a coding agent
// (e.g. Claude Code, opencode) sent via `wsh agentnotify`.
type AgentNotification struct {
	NotifyId    string `json:"notifyid"`              // uuidv7
	ORef        string `json:"oref"`                  // "block:uuid" — originating block (optional)
	TabId       string `json:"tabid"`                 // tab containing the block
	WorkspaceId string `json:"workspaceid"`            // workspace oid
	WindowId    string `json:"windowid"`              // window oid (filled by backend)
	Agent       string `json:"agent,omitempty"`       // agent executable name (e.g. "claude", "opencode")
	Status      string `json:"status"`                // "completion"|"question"|"waiting"|"error"|"info"
	Lifecycle   string `json:"lifecycle,omitempty"`   // "terminal"|"intermediate" (defaults to terminal)
	Message     string `json:"message"`               // notification text
	WorkDir     string `json:"workdir,omitempty"`     // working directory
	Branch      string `json:"branch,omitempty"`      // git branch
	Worktree    string `json:"worktree,omitempty"`    // git worktree root path
	Timestamp     int64  `json:"timestamp"`                  // unix ms
	WorkspaceName string `json:"workspacename,omitempty"`    // filled by backend
}

// AgentNotifyEvent is the payload for Event_AgentNotify events.
type AgentNotifyEvent struct {
	Notification *AgentNotification `json:"notification,omitempty"`
	Clear        bool               `json:"clear,omitempty"`
	ClearAll     bool               `json:"clearall,omitempty"`
	NotifyId     string             `json:"notifyid,omitempty"` // for targeted clear
}
