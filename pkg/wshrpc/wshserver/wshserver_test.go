// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestResolveAgentNotificationStoresIntermediate(t *testing.T) {
	incoming := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "error",
		Lifecycle: "intermediate",
		Message:   "go test failed",
		Timestamp: 100,
	}

	resolved, storePending := resolveAgentNotification(incoming, baseds.AgentNotification{}, false, baseds.AgentNotification{}, false, 10000)
	if resolved != nil {
		t.Fatalf("expected intermediate notification to stay hidden")
	}
	if !storePending {
		t.Fatalf("expected intermediate notification to be stored as pending")
	}
}

func TestResolveAgentNotificationUsesPendingErrorMessage(t *testing.T) {
	incoming := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "error",
		Lifecycle: "terminal",
		Message:   "Task failed",
		Timestamp: 200,
	}
	pending := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "error",
		Message:   "go test ./... failed",
		Timestamp: 150,
	}

	resolved, storePending := resolveAgentNotification(incoming, baseds.AgentNotification{}, false, pending, true, 10000)
	if storePending {
		t.Fatalf("did not expect terminal notification to be stored as pending")
	}
	if resolved == nil {
		t.Fatalf("expected terminal error to be published")
	}
	if resolved.Message != "go test ./... failed" {
		t.Fatalf("expected pending error message to win, got %q", resolved.Message)
	}
}

func TestResolveAgentNotificationSuppressesCompletionAfterRecentError(t *testing.T) {
	existing := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "error",
		Lifecycle: "terminal",
		Message:   "task failed",
		Timestamp: 100,
	}
	incoming := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "completion",
		Lifecycle: "terminal",
		Message:   "task complete",
		Timestamp: 105,
	}

	resolved, storePending := resolveAgentNotification(incoming, existing, true, baseds.AgentNotification{}, false, 10000)
	if storePending {
		t.Fatalf("did not expect completion to be stored as pending")
	}
	if resolved != nil {
		t.Fatalf("expected completion after recent terminal error to be suppressed")
	}
}

func TestResolveAgentNotificationPublishesCompletionAfterIntermediateError(t *testing.T) {
	incoming := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "completion",
		Lifecycle: "terminal",
		Message:   "task complete",
		Timestamp: 200,
	}
	pending := baseds.AgentNotification{
		NotifyId:  "n1",
		Status:    "error",
		Lifecycle: "intermediate",
		Message:   "go test failed",
		Timestamp: 150,
	}

	resolved, storePending := resolveAgentNotification(incoming, baseds.AgentNotification{}, false, pending, true, 10000)
	if storePending {
		t.Fatalf("did not expect terminal completion to be stored as pending")
	}
	if resolved == nil || resolved.Status != "completion" {
		t.Fatalf("expected terminal completion to be published")
	}
}
