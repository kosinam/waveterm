// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var agentNotifyCmd = &cobra.Command{
	Use:   "agentnotify <message>",
	Short: "send an agent status notification to the waveterm notification panel",
	Long: `Send an agent status notification to the waveterm notification panel.
The notification appears in the collapsible Agent panel on the left side of the workspace.
Clicking the notification switches focus to the originating block.

For Claude Code Stop hooks, use the dedicated command instead:
  wsh agenthook claude stop

That command reads the transcript automatically from the hook stdin.
See: wsh agenthook --help`,
	Args:    cobra.ExactArgs(1),
	RunE:    agentNotifyRun,
	PreRunE: preRunSetupRpcClient,
}

var (
	agentNotifyStatus   string
	agentNotifyWorkDir  string
	agentNotifyBranch   string
	agentNotifyWorktree string
	agentNotifyBeep     bool
	agentNotifyTitle    string
	agentNotifyNotifyId string
	agentNotifyAgent    string
)

func init() {
	rootCmd.AddCommand(agentNotifyCmd)
	agentNotifyCmd.Flags().StringVar(&agentNotifyStatus, "status", "info", "agent status: completion, question, waiting, error, info")
	agentNotifyCmd.Flags().StringVar(&agentNotifyWorkDir, "workdir", "", "working directory (defaults to $PWD)")
	agentNotifyCmd.Flags().StringVar(&agentNotifyBranch, "branch", "", "current git branch")
	agentNotifyCmd.Flags().StringVar(&agentNotifyWorktree, "worktree", "", "git worktree root path")
	agentNotifyCmd.Flags().BoolVar(&agentNotifyBeep, "beep", false, "play system bell sound")
	agentNotifyCmd.Flags().StringVar(&agentNotifyTitle, "title", "", "also send an OS desktop notification with this title")
	agentNotifyCmd.Flags().StringVar(&agentNotifyNotifyId, "notifyid", "", "stable notification ID for upsert (overrides block ORef and random UUID)")
	agentNotifyCmd.Flags().StringVar(&agentNotifyAgent, "agent", "", "agent executable name shown in notification (e.g. claude, opencode)")
}

func agentNotifyRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agentnotify", rtnErr == nil)
	}()

	message := args[0]

	workDir := agentNotifyWorkDir
	if workDir == "" {
		workDir = os.Getenv("PWD")
	}

	oref, _ := resolveBlockArg()
	orefStr := ""
	if oref != nil {
		orefStr = oref.String()
	}

	// Determine a stable notifyid for upsert behavior (same ID = panel entry is updated
	// rather than duplicated). Three-tier precedence:
	//   1. --notifyid flag (caller-supplied, e.g. opencode session ID)
	//   2. Block ORef (existing behavior: same wave pane overwrites its notification)
	//   3. Random UUID fallback
	var notifyId string
	var err error
	if agentNotifyNotifyId != "" {
		notifyId = agentNotifyNotifyId
	} else if orefStr != "" {
		notifyId = orefStr
	} else {
		var id uuid.UUID
		id, err = uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generating notify id: %v", err)
		}
		notifyId = id.String()
	}

	notification := baseds.AgentNotification{
		NotifyId: notifyId,
		ORef:     orefStr,
		Agent:    agentNotifyAgent,
		Status:   agentNotifyStatus,
		Message:  message,
		WorkDir:  workDir,
		Branch:   agentNotifyBranch,
		Worktree: agentNotifyWorktree,
	}

	err = wshclient.AgentNotifyCommand(RpcClient, notification, &wshrpc.RpcOpts{NoResponse: true})
	if err != nil {
		return fmt.Errorf("sending agent notification: %v", err)
	}

	if agentNotifyBeep {
		err = wshclient.ElectronSystemBellCommand(RpcClient, &wshrpc.RpcOpts{Route: "electron"})
		if err != nil {
			return fmt.Errorf("playing system bell: %v", err)
		}
	}

	if agentNotifyTitle != "" {
		notifyOpts := wshrpc.WaveNotificationOptions{
			Title: agentNotifyTitle,
			Body:  message,
		}
		err = wshclient.NotifyCommand(RpcClient, notifyOpts, &wshrpc.RpcOpts{Route: "electron"})
		if err != nil {
			return fmt.Errorf("sending OS notification: %v", err)
		}
	}

	return nil
}
