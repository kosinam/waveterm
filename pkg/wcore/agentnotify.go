// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"log"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// AgentNotifyStore is an in-memory store for transient agent notifications.
// Notifications are not persisted and are cleared on restart.
type AgentNotifyStore struct {
	lock          *sync.Mutex
	notifications map[string]baseds.AgentNotification // keyed by notifyid
	pending       map[string]baseds.AgentNotification // keyed by notifyid
}

var globalAgentNotifyStore = &AgentNotifyStore{
	lock:          &sync.Mutex{},
	notifications: make(map[string]baseds.AgentNotification),
	pending:       make(map[string]baseds.AgentNotification),
}

// InitAgentNotifyStore subscribes to incoming agent notify events.
func InitAgentNotifyStore() error {
	log.Printf("initializing agent notify store\n")

	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_AgentNotify, handleAgentNotifyEvent)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{
		Event:     wps.Event_AgentNotify,
		AllScopes: true,
	}, nil)

	return nil
}

func handleAgentNotifyEvent(event *wps.WaveEvent) {
	if event.Event != wps.Event_AgentNotify {
		return
	}
	var data baseds.AgentNotifyEvent
	err := utilfn.ReUnmarshal(&data, event.Data)
	if err != nil {
		log.Printf("agent notify store: error unmarshaling AgentNotifyEvent: %v\n", err)
		return
	}
	if data.ClearAll {
		clearAllAgentNotifications()
		return
	}
	if data.Clear && data.NotifyId != "" {
		clearAgentNotification(data.NotifyId)
		return
	}
	if data.Notification == nil {
		return
	}
	addAgentNotification(*data.Notification)
}

func addAgentNotification(n baseds.AgentNotification) {
	if n.NotifyId == "" {
		return
	}
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	globalAgentNotifyStore.notifications[n.NotifyId] = n
	log.Printf("agent notify store: notification added: id=%s status=%s\n", n.NotifyId, n.Status)
}

func SetPendingAgentNotification(n baseds.AgentNotification) {
	if n.NotifyId == "" {
		return
	}
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	globalAgentNotifyStore.pending[n.NotifyId] = n
	log.Printf("agent notify store: pending notification stored: id=%s status=%s\n", n.NotifyId, n.Status)
}

func GetPendingAgentNotification(notifyId string) (baseds.AgentNotification, bool) {
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	n, ok := globalAgentNotifyStore.pending[notifyId]
	return n, ok
}

func ClearPendingAgentNotification(notifyId string) {
	if notifyId == "" {
		return
	}
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	delete(globalAgentNotifyStore.pending, notifyId)
	log.Printf("agent notify store: pending notification cleared: id=%s\n", notifyId)
}

func clearAgentNotification(notifyId string) {
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	delete(globalAgentNotifyStore.notifications, notifyId)
	delete(globalAgentNotifyStore.pending, notifyId)
	log.Printf("agent notify store: notification cleared: id=%s\n", notifyId)
}

func clearAllAgentNotifications() {
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	count := len(globalAgentNotifyStore.notifications)
	globalAgentNotifyStore.notifications = make(map[string]baseds.AgentNotification)
	globalAgentNotifyStore.pending = make(map[string]baseds.AgentNotification)
	log.Printf("agent notify store: cleared all %d notifications\n", count)
}

// GetAgentNotification returns a single notification by id, and whether it exists.
func GetAgentNotification(notifyId string) (baseds.AgentNotification, bool) {
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	n, ok := globalAgentNotifyStore.notifications[notifyId]
	return n, ok
}

// GetAllAgentNotifications returns a snapshot of all current notifications.
func GetAllAgentNotifications() []baseds.AgentNotification {
	globalAgentNotifyStore.lock.Lock()
	defer globalAgentNotifyStore.lock.Unlock()
	result := make([]baseds.AgentNotification, 0, len(globalAgentNotifyStore.notifications))
	for _, n := range globalAgentNotifyStore.notifications {
		result = append(result, n)
	}
	return result
}
