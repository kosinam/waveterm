// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { globalStore } from "@/app/store/jotaiStore";
import { isBuilderWindow } from "@/app/store/windowtype";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { atoms, getApi, getOrefMetaKeyAtom, getSettingsKeyAtom, recordTEvent, refocusNode } from "@/store/global";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "lodash-es";
import { ImperativePanelGroupHandle, ImperativePanelHandle } from "react-resizable-panels";

const dlog = debug("wave:workspace");

const AIPanel_DefaultWidth = 300;
const AIPanel_DefaultWidthRatio = 0.33;
const AIPanel_MinWidth = 300;
const AIPanel_MaxWidthRatio = 0.66;

const VTabBar_DefaultWidth = 220;
const VTabBar_MinWidth = 110;
const VTabBar_MaxWidth = 280;

const AgentNotifyPanel_DefaultWidth = 325;
const AgentNotifyPanel_MinWidth = 200;
const AgentNotifyPanel_MaxWidth = 525;

function clampVTabWidth(w: number): number {
    return Math.max(VTabBar_MinWidth, Math.min(w, VTabBar_MaxWidth));
}

function clampAgentNotifyWidth(w: number): number {
    return Math.max(AgentNotifyPanel_MinWidth, Math.min(w, AgentNotifyPanel_MaxWidth));
}

function clampAIPanelWidth(w: number, windowWidth: number): number {
    const maxWidth = Math.floor(windowWidth * AIPanel_MaxWidthRatio);
    if (AIPanel_MinWidth > maxWidth) return AIPanel_MinWidth;
    return Math.max(AIPanel_MinWidth, Math.min(w, maxWidth));
}

class WorkspaceLayoutModel {
    private static instance: WorkspaceLayoutModel | null = null;

    aiPanelRef: ImperativePanelHandle | null;
    vtabPanelRef: ImperativePanelHandle | null;
    agentNotifyPanelRef: ImperativePanelHandle | null;
    outerPanelGroupRef: ImperativePanelGroupHandle | null;
    innerPanelGroupRef: ImperativePanelGroupHandle | null;
    panelContainerRef: HTMLDivElement | null;
    aiPanelWrapperRef: HTMLDivElement | null;
    vtabPanelWrapperRef: HTMLDivElement | null;
    panelVisibleAtom: jotai.PrimitiveAtom<boolean>;
    agentNotifyPanelVisibleAtom: jotai.PrimitiveAtom<boolean>;

    private inResize: boolean;
    private aiPanelVisible: boolean;
    private aiPanelWidth: number | null;
    private vtabWidth: number;
    private vtabVisible: boolean;
    private agentNotifyPanelVisible: boolean;
    private agentNotifyPanelWidth: number;
    private transitionTimeoutRef: NodeJS.Timeout | null = null;
    private focusTimeoutRef: NodeJS.Timeout | null = null;
    private debouncedPersistAIWidth: () => void;
    private debouncedPersistVTabWidth: () => void;
    private debouncedPersistAgentNotifyWidth: () => void;

    private constructor() {
        this.aiPanelRef = null;
        this.vtabPanelRef = null;
        this.agentNotifyPanelRef = null;
        this.outerPanelGroupRef = null;
        this.innerPanelGroupRef = null;
        this.panelContainerRef = null;
        this.aiPanelWrapperRef = null;
        this.vtabPanelWrapperRef = null;
        this.inResize = false;
        this.aiPanelVisible = false;
        this.aiPanelWidth = null;
        this.vtabWidth = VTabBar_DefaultWidth;
        this.vtabVisible = false;
        this.agentNotifyPanelVisible = true;
        this.agentNotifyPanelWidth = AgentNotifyPanel_DefaultWidth;
        this.panelVisibleAtom = jotai.atom(false);
        this.agentNotifyPanelVisibleAtom = jotai.atom(true);
        this.initializeFromMeta();

        this.handleWindowResize = this.handleWindowResize.bind(this);
        this.handleOuterPanelLayout = this.handleOuterPanelLayout.bind(this);
        this.handleInnerPanelLayout = this.handleInnerPanelLayout.bind(this);

        this.debouncedPersistAIWidth = debounce(() => {
            if (!this.aiPanelVisible) return;
            const width = this.aiPanelWrapperRef?.offsetWidth;
            if (width == null || width <= 0) return;
            try {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("tab", this.getTabId()),
                    meta: { "waveai:panelwidth": width },
                });
            } catch (e) {
                console.warn("Failed to persist AI panel width:", e);
            }
        }, 300);

        this.debouncedPersistVTabWidth = debounce(() => {
            if (!this.vtabVisible) return;
            const width = this.vtabPanelWrapperRef?.offsetWidth;
            if (width == null || width <= 0) return;
            try {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                    meta: { "layout:vtabbarwidth": width },
                });
            } catch (e) {
                console.warn("Failed to persist vtabbar width:", e);
            }
        }, 300);

        this.debouncedPersistAgentNotifyWidth = debounce(() => {
            if (!this.agentNotifyPanelVisible) return;
            try {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                    meta: { "layout:agentnotifypanelwidth": this.agentNotifyPanelWidth },
                });
            } catch (e) {
                console.warn("Failed to persist agent notify panel width:", e);
            }
        }, 300);
    }

    static getInstance(): WorkspaceLayoutModel {
        if (!WorkspaceLayoutModel.instance) {
            WorkspaceLayoutModel.instance = new WorkspaceLayoutModel();
        }
        return WorkspaceLayoutModel.instance;
    }

    // ---- Meta / persistence helpers ----

    private getTabId(): string {
        return globalStore.get(atoms.staticTabId);
    }

    private getWorkspaceId(): string {
        return globalStore.get(atoms.workspace)?.oid ?? "";
    }

    private getPanelOpenAtom(): jotai.Atom<boolean> {
        return getOrefMetaKeyAtom(WOS.makeORef("tab", this.getTabId()), "waveai:panelopen");
    }

    private getPanelWidthAtom(): jotai.Atom<number> {
        return getOrefMetaKeyAtom(WOS.makeORef("tab", this.getTabId()), "waveai:panelwidth");
    }

    private getVTabBarWidthAtom(): jotai.Atom<number> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:vtabbarwidth");
    }

    private getAgentNotifyPanelOpenAtom(): jotai.Atom<boolean> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:agentnotifypanelopen");
    }

    private getAgentNotifyPanelWidthAtom(): jotai.Atom<number> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:agentnotifypanelwidth");
    }

    private initializeFromMeta(): void {
        try {
            const savedVisible = globalStore.get(this.getPanelOpenAtom());
            const savedAIWidth = globalStore.get(this.getPanelWidthAtom());
            const savedVTabWidth = globalStore.get(this.getVTabBarWidthAtom());
            const savedAgentNotifyVisible = globalStore.get(this.getAgentNotifyPanelOpenAtom());
            const savedAgentNotifyWidth = globalStore.get(this.getAgentNotifyPanelWidthAtom());
            if (savedVisible != null) {
                this.aiPanelVisible = savedVisible;
                globalStore.set(this.panelVisibleAtom, savedVisible);
            }
            if (savedAIWidth != null) {
                this.aiPanelWidth = savedAIWidth;
            }
            if (savedVTabWidth != null && savedVTabWidth > 0) {
                this.vtabWidth = savedVTabWidth;
            }
            if (savedAgentNotifyVisible != null) {
                this.agentNotifyPanelVisible = savedAgentNotifyVisible;
                globalStore.set(this.agentNotifyPanelVisibleAtom, savedAgentNotifyVisible);
            }
            if (savedAgentNotifyWidth != null && savedAgentNotifyWidth > 0) {
                this.agentNotifyPanelWidth = clampAgentNotifyWidth(savedAgentNotifyWidth);
            }
            const tabBarPosition = globalStore.get(getSettingsKeyAtom("app:tabbar")) ?? "top";
            const showLeftTabBar = tabBarPosition === "left" && !isBuilderWindow();
            this.vtabVisible = showLeftTabBar;
        } catch (e) {
            console.warn("Failed to initialize from tab meta:", e);
        }
    }

    // ---- Resolved width getters (always clamped) ----

    private getResolvedAgentNotifyWidth(): number {
        return clampAgentNotifyWidth(this.agentNotifyPanelWidth);
    }

    private getResolvedAIWidth(windowWidth: number): number {
        let w = this.aiPanelWidth;
        if (w == null) {
            w = Math.max(AIPanel_DefaultWidth, windowWidth * AIPanel_DefaultWidthRatio);
            this.aiPanelWidth = w;
        }
        return clampAIPanelWidth(w, windowWidth);
    }

    private getResolvedVTabWidth(): number {
        return clampVTabWidth(this.vtabWidth);
    }

    // ---- Core layout computation ----
    // All layout decisions flow through computeLayout.
    // It takes the current state (visibility flags + stored px widths)
    // and produces the two percentage arrays for the panel groups.

    private computeLayout(windowWidth: number): { outer: number[]; inner: number[] } {
        const agentNotifyW = this.agentNotifyPanelVisible ? this.getResolvedAgentNotifyWidth() : 0;
        const vtabW = this.vtabVisible ? this.getResolvedVTabWidth() : 0;
        const aiW = this.aiPanelVisible ? this.getResolvedAIWidth(windowWidth) : 0;
        const leftGroupW = vtabW + aiW;

        // outer: [agentNotifyPct, leftGroupPct, contentPct]
        const agentNotifyPct = windowWidth > 0 ? (agentNotifyW / windowWidth) * 100 : 0;
        const leftPct = windowWidth > 0 ? (leftGroupW / windowWidth) * 100 : 0;
        const contentPct = Math.max(0, 100 - agentNotifyPct - leftPct);

        // inner: [vtabPct, aiPanelPct] relative to leftGroupW
        let vtabPct: number;
        let aiPct: number;
        if (leftGroupW > 0) {
            vtabPct = (vtabW / leftGroupW) * 100;
            aiPct = 100 - vtabPct;
        } else {
            vtabPct = 50;
            aiPct = 50;
        }

        return { outer: [agentNotifyPct, leftPct, contentPct], inner: [vtabPct, aiPct] };
    }

    private commitLayouts(windowWidth: number): void {
        if (!this.outerPanelGroupRef || !this.innerPanelGroupRef) return;
        const { outer, inner } = this.computeLayout(windowWidth);
        this.inResize = true;
        this.outerPanelGroupRef.setLayout(outer);
        this.innerPanelGroupRef.setLayout(inner);
        this.inResize = false;
        this.updateWrapperWidth();
    }

    // ---- Drag handlers ----
    // These convert the percentage-based callback from react-resizable-panels
    // back into pixel widths, update stored state, then re-commit.

    handleOuterPanelLayout(sizes: number[]): void {
        if (this.inResize) return;
        const windowWidth = window.innerWidth;
        // sizes: [agentNotifyPct, leftGroupPct, contentPct]
        const newAgentNotifyPx = (sizes[0] / 100) * windowWidth;
        const newLeftGroupPx = (sizes[1] / 100) * windowWidth;

        // Update agent notify width if it was resized
        if (this.agentNotifyPanelVisible && newAgentNotifyPx > 0) {
            this.agentNotifyPanelWidth = clampAgentNotifyWidth(newAgentNotifyPx);
            this.debouncedPersistAgentNotifyWidth();
        }

        if (this.vtabVisible && this.aiPanelVisible) {
            // vtab stays constant, aipanel absorbs the change
            const vtabW = this.getResolvedVTabWidth();
            this.aiPanelWidth = clampAIPanelWidth(newLeftGroupPx - vtabW, windowWidth);
            this.debouncedPersistAIWidth();
        } else if (this.vtabVisible) {
            this.vtabWidth = clampVTabWidth(newLeftGroupPx);
            this.debouncedPersistVTabWidth();
        } else if (this.aiPanelVisible) {
            this.aiPanelWidth = clampAIPanelWidth(newLeftGroupPx, windowWidth);
            this.debouncedPersistAIWidth();
        }

        this.commitLayouts(windowWidth);
    }

    handleInnerPanelLayout(sizes: number[]): void {
        if (this.inResize) return;
        if (!this.vtabVisible || !this.aiPanelVisible) return;

        const windowWidth = window.innerWidth;
        const vtabW = this.getResolvedVTabWidth();
        const aiW = this.getResolvedAIWidth(windowWidth);
        const leftGroupW = vtabW + aiW;

        const newVTabW = (sizes[0] / 100) * leftGroupW;
        const clampedVTab = clampVTabWidth(newVTabW);
        const newAIW = clampAIPanelWidth(leftGroupW - clampedVTab, windowWidth);

        if (clampedVTab !== this.vtabWidth) {
            this.vtabWidth = clampedVTab;
            this.debouncedPersistVTabWidth();
        }
        if (newAIW !== this.aiPanelWidth) {
            this.aiPanelWidth = newAIW;
            this.debouncedPersistAIWidth();
        }

        this.commitLayouts(windowWidth);
    }

    handleWindowResize(): void {
        this.commitLayouts(window.innerWidth);
    }

    // ---- Registration & sync ----

    syncVTabWidthFromMeta(): void {
        const savedVTabWidth = globalStore.get(this.getVTabBarWidthAtom());
        if (savedVTabWidth != null && savedVTabWidth > 0 && savedVTabWidth !== this.vtabWidth) {
            this.vtabWidth = savedVTabWidth;
            this.commitLayouts(window.innerWidth);
        }
    }

    registerRefs(
        aiPanelRef: ImperativePanelHandle,
        outerPanelGroupRef: ImperativePanelGroupHandle,
        innerPanelGroupRef: ImperativePanelGroupHandle,
        panelContainerRef: HTMLDivElement,
        aiPanelWrapperRef: HTMLDivElement,
        vtabPanelRef?: ImperativePanelHandle,
        vtabPanelWrapperRef?: HTMLDivElement,
        showLeftTabBar?: boolean
    ): void {
        this.aiPanelRef = aiPanelRef;
        this.vtabPanelRef = vtabPanelRef ?? null;
        this.outerPanelGroupRef = outerPanelGroupRef;
        this.innerPanelGroupRef = innerPanelGroupRef;
        this.panelContainerRef = panelContainerRef;
        this.aiPanelWrapperRef = aiPanelWrapperRef;
        this.vtabPanelWrapperRef = vtabPanelWrapperRef ?? null;
        this.vtabVisible = showLeftTabBar ?? false;
        this.syncPanelCollapse();
        this.commitLayouts(window.innerWidth);
    }

    private syncPanelCollapse(): void {
        if (this.aiPanelRef) {
            if (this.aiPanelVisible) {
                this.aiPanelRef.expand();
            } else {
                this.aiPanelRef.collapse();
            }
        }
        if (this.vtabPanelRef) {
            if (this.vtabVisible) {
                this.vtabPanelRef.expand();
            } else {
                this.vtabPanelRef.collapse();
            }
        }
        if (this.agentNotifyPanelRef) {
            if (this.agentNotifyPanelVisible) {
                this.agentNotifyPanelRef.expand();
            } else {
                this.agentNotifyPanelRef.collapse();
            }
        }
    }

    // ---- Transitions ----

    enableTransitions(duration: number): void {
        if (!this.panelContainerRef) return;
        const panels = this.panelContainerRef.querySelectorAll("[data-panel]");
        panels.forEach((panel: HTMLElement) => {
            panel.style.transition = "flex 0.2s ease-in-out";
        });
        if (this.transitionTimeoutRef) {
            clearTimeout(this.transitionTimeoutRef);
        }
        this.transitionTimeoutRef = setTimeout(() => {
            if (!this.panelContainerRef) return;
            const panels = this.panelContainerRef.querySelectorAll("[data-panel]");
            panels.forEach((panel: HTMLElement) => {
                panel.style.transition = "none";
            });
        }, duration);
    }

    // ---- Wrapper width (AI panel inner content width) ----

    updateWrapperWidth(): void {
        if (!this.aiPanelWrapperRef) return;
        const width = this.getResolvedAIWidth(window.innerWidth);
        this.aiPanelWrapperRef.style.width = `${width}px`;
    }

    // ---- Registration for agent notify panel ----

    registerAgentNotifyPanelRef(ref: ImperativePanelHandle | null): void {
        this.agentNotifyPanelRef = ref;
        this.syncPanelCollapse();
        this.commitLayouts(window.innerWidth);
    }

    // ---- Public getters ----

    getAIPanelVisible(): boolean {
        return this.aiPanelVisible;
    }

    getAIPanelWidth(): number {
        return this.getResolvedAIWidth(window.innerWidth);
    }

    getAgentNotifyPanelVisible(): boolean {
        return this.agentNotifyPanelVisible;
    }

    // ---- Initial percentage helpers (used by workspace.tsx for defaultSize) ----

    getLeftGroupInitialPercentage(windowWidth: number, showLeftTabBar: boolean): number {
        const vtabW = showLeftTabBar && !isBuilderWindow() ? this.getResolvedVTabWidth() : 0;
        const aiW = this.aiPanelVisible ? this.getResolvedAIWidth(windowWidth) : 0;
        return ((vtabW + aiW) / windowWidth) * 100;
    }

    getInnerVTabInitialPercentage(windowWidth: number, showLeftTabBar: boolean): number {
        if (!showLeftTabBar || isBuilderWindow()) return 0;
        const vtabW = this.getResolvedVTabWidth();
        const aiW = this.aiPanelVisible ? this.getResolvedAIWidth(windowWidth) : 0;
        const total = vtabW + aiW;
        if (total === 0) return 50;
        return (vtabW / total) * 100;
    }

    getAgentNotifyPanelInitialPercentage(windowWidth: number): number {
        if (!this.agentNotifyPanelVisible) return 0;
        return (this.getResolvedAgentNotifyWidth() / windowWidth) * 100;
    }

    getInnerAIPanelInitialPercentage(windowWidth: number, showLeftTabBar: boolean): number {
        const vtabW = showLeftTabBar && !isBuilderWindow() ? this.getResolvedVTabWidth() : 0;
        const aiW = this.aiPanelVisible ? this.getResolvedAIWidth(windowWidth) : 0;
        const total = vtabW + aiW;
        if (total === 0) return 50;
        return (aiW / total) * 100;
    }

    // ---- Toggle visibility ----

    setAIPanelVisible(visible: boolean, opts?: { nofocus?: boolean }): void {
        if (this.focusTimeoutRef != null) {
            clearTimeout(this.focusTimeoutRef);
            this.focusTimeoutRef = null;
        }
        const wasVisible = this.aiPanelVisible;
        this.aiPanelVisible = visible;
        if (visible && !wasVisible) {
            recordTEvent("action:openwaveai");
        }
        globalStore.set(this.panelVisibleAtom, visible);
        getApi().setWaveAIOpen(visible);
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", this.getTabId()),
            meta: { "waveai:panelopen": visible },
        });
        this.enableTransitions(250);
        this.syncPanelCollapse();
        this.commitLayouts(window.innerWidth);

        if (visible) {
            if (!opts?.nofocus) {
                this.focusTimeoutRef = setTimeout(() => {
                    WaveAIModel.getInstance().focusInput();
                    this.focusTimeoutRef = null;
                }, 350);
            }
        } else {
            const layoutModel = getLayoutModelForStaticTab();
            const focusedNode = globalStore.get(layoutModel.focusedNode);
            if (focusedNode == null) {
                layoutModel.focusFirstNode();
                return;
            }
            const blockId = focusedNode?.data?.blockId;
            if (blockId != null) {
                refocusNode(blockId);
            }
        }
    }

    setAgentNotifyPanelVisible(visible: boolean): void {
        this.agentNotifyPanelVisible = visible;
        globalStore.set(this.agentNotifyPanelVisibleAtom, visible);
        try {
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                meta: { "layout:agentnotifypanelopen": visible },
            });
        } catch (e) {
            console.warn("Failed to persist agent notify panel visibility:", e);
        }
        this.enableTransitions(250);
        this.syncPanelCollapse();
        this.commitLayouts(window.innerWidth);
    }

    setShowLeftTabBar(showLeftTabBar: boolean): void {
        if (this.vtabVisible === showLeftTabBar) return;
        this.vtabVisible = showLeftTabBar;
        this.enableTransitions(250);
        this.syncPanelCollapse();
        this.commitLayouts(window.innerWidth);
    }
}

export { WorkspaceLayoutModel };
