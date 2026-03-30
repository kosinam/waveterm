// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { FocusManager, type FocusStrType } from "@/app/store/focusManager";
import { atoms, getApi, globalStore, refocusNode } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";

const FocusHistoryStorageKey = "wave:focus-history";
const PendingFocusNavigationStorageKey = "wave:pending-focus-navigation";
const MaxFocusHistoryEntries = 50;

export type FocusLocation = {
    workspaceId: string | null;
    tabId: string | null;
    focusType: FocusStrType;
    blockId?: string | null;
};

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function isValidFocusLocation(value: any): value is FocusLocation {
    if (value == null || typeof value !== "object") {
        return false;
    }
    if ((value.focusType !== "node" && value.focusType !== "waveai") || typeof value.tabId !== "string") {
        return false;
    }
    if (value.workspaceId != null && typeof value.workspaceId !== "string") {
        return false;
    }
    if (value.blockId != null && typeof value.blockId !== "string") {
        return false;
    }
    return true;
}

function readFocusHistory(): FocusLocation[] {
    const storage = getStorage();
    if (storage == null) {
        return [];
    }
    const raw = storage.getItem(FocusHistoryStorageKey);
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter(isValidFocusLocation);
    } catch {
        return [];
    }
}

function writeFocusHistory(history: FocusLocation[]): void {
    const storage = getStorage();
    if (storage == null) {
        return;
    }
    storage.setItem(FocusHistoryStorageKey, JSON.stringify(history));
}

function readPendingFocusNavigation(): FocusLocation | null {
    const storage = getStorage();
    if (storage == null) {
        return null;
    }
    const raw = storage.getItem(PendingFocusNavigationStorageKey);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return isValidFocusLocation(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writePendingFocusNavigation(location: FocusLocation | null): void {
    const storage = getStorage();
    if (storage == null) {
        return;
    }
    if (location == null) {
        storage.removeItem(PendingFocusNavigationStorageKey);
        return;
    }
    storage.setItem(PendingFocusNavigationStorageKey, JSON.stringify(location));
}

export function isSameFocusLocation(a: FocusLocation | null, b: FocusLocation | null): boolean {
    if (a == null || b == null) {
        return false;
    }
    return (
        a.workspaceId === b.workspaceId &&
        a.tabId === b.tabId &&
        a.focusType === b.focusType &&
        (a.blockId ?? null) === (b.blockId ?? null)
    );
}

export function pushFocusLocation(history: FocusLocation[], location: FocusLocation): FocusLocation[] {
    const normalizedHistory = history.filter(isValidFocusLocation);
    const lastLocation = normalizedHistory[normalizedHistory.length - 1];
    if (isSameFocusLocation(lastLocation, location)) {
        return normalizedHistory;
    }
    return [...normalizedHistory, location].slice(-MaxFocusHistoryEntries);
}

export function getPreviousFocusLocationFromHistory(
    history: FocusLocation[],
    currentLocation: FocusLocation | null
): FocusLocation | null {
    const normalizedHistory = history.filter(isValidFocusLocation);
    for (let idx = normalizedHistory.length - 1; idx >= 0; idx--) {
        const candidate = normalizedHistory[idx];
        if (!isSameFocusLocation(candidate, currentLocation)) {
            return candidate;
        }
    }
    return null;
}

export function getCurrentFocusLocation(): FocusLocation | null {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const tabId = globalStore.get(atoms.staticTabId);
    if (tabId == null) {
        return null;
    }
    const focusType = globalStore.get(FocusManager.getInstance().focusType);
    if (focusType === "waveai") {
        return { workspaceId, tabId, focusType: "waveai" };
    }
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    const blockId = focusedNode?.data?.blockId;
    if (blockId == null) {
        return null;
    }
    return { workspaceId, tabId, focusType: "node", blockId };
}

export function recordFocusLocation(location: FocusLocation | null): void {
    if (location == null) {
        return;
    }
    const history = readFocusHistory();
    writeFocusHistory(pushFocusLocation(history, location));
}

export function recordCurrentFocusLocation(): void {
    recordFocusLocation(getCurrentFocusLocation());
}

export function getPendingFocusNavigation(): FocusLocation | null {
    return readPendingFocusNavigation();
}

export function setPendingFocusNavigation(location: FocusLocation | null): void {
    writePendingFocusNavigation(location);
}

export function clearPendingFocusNavigation(): void {
    writePendingFocusNavigation(null);
}

function focusLocationInCurrentRenderer(location: FocusLocation): boolean {
    if (location.focusType === "waveai") {
        FocusManager.getInstance().setWaveAIFocused(true);
        return true;
    }
    if (location.blockId == null) {
        return false;
    }
    refocusNode(location.blockId);
    return true;
}

export function applyPendingFocusNavigationForCurrentTab(): boolean {
    const pendingLocation = readPendingFocusNavigation();
    if (pendingLocation == null) {
        return false;
    }
    const currentTabId = globalStore.get(atoms.staticTabId);
    if (pendingLocation.tabId !== currentTabId) {
        return false;
    }
    const currentLocation = getCurrentFocusLocation();
    if (isSameFocusLocation(currentLocation, pendingLocation)) {
        clearPendingFocusNavigation();
        return false;
    }
    return focusLocationInCurrentRenderer(pendingLocation);
}

export async function navigateToFocusLocation(location: FocusLocation | null): Promise<boolean> {
    if (location == null || location.tabId == null) {
        return false;
    }

    const currentWorkspaceId = globalStore.get(atoms.workspaceId);
    const currentTabId = globalStore.get(atoms.staticTabId);
    const sameWorkspace = location.workspaceId === currentWorkspaceId;
    const sameTab = location.tabId === currentTabId;

    if (sameWorkspace && sameTab) {
        return focusLocationInCurrentRenderer(location);
    }

    setPendingFocusNavigation(location);

    if (!sameWorkspace && location.workspaceId) {
        getApi().switchWorkspace(location.workspaceId);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!sameTab) {
        getApi().setActiveTab(location.tabId);
    }
    return true;
}

export async function navigateToPreviousFocus(): Promise<boolean> {
    const currentLocation = getCurrentFocusLocation();
    recordFocusLocation(currentLocation);
    const previousLocation = getPreviousFocusLocationFromHistory(readFocusHistory(), currentLocation);
    if (previousLocation == null) {
        return false;
    }
    return navigateToFocusLocation(previousLocation);
}
