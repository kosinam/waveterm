# WaveTerm — Fork Differences

> **Original WaveTerm README:** [README.upstream.md](README.upstream.md)

This fork of [WaveTerm](https://github.com/wavetermdev/waveterm) adds several quality-of-life features focused on keyboard-driven workflows and AI agent integration.

---

## tmux-style Ctrl-B Chord Keybindings

A configurable prefix chord is layered on top of WaveTerm's existing keybindings. The default prefix is **`Ctrl-W`** — chosen to avoid conflict with nested tmux sessions, which use `Ctrl-B` by default (WaveTerm would otherwise intercept `Ctrl-B` before tmux sees it).

To change the prefix, set `app:chordprefix` in your WaveTerm `settings.json` and restart. For example, to use the tmux default:

```json
{ "app:chordprefix": "Ctrl:b" }
```

After pressing the prefix key, a short window accepts the following keys:

| Key | Action |
|-----|--------|
| `%` / `"` | Split pane right / below |
| `c` | New tab (tmux window equivalent) |
| `n` / `p` | Next / previous tab |
| `1`–`9` | Switch workspace by number |
| `(` / `)` | Previous / next workspace |
| `←→↑↓` | Navigate panes |
| `z` | Zoom / magnify pane |
| `x` | Close pane |
| `b` / `B` | New browser pane right / below |
| `f` / `F` | New file browser pane right / below |
| `w` | Toggle widget panel |
| `a` | Toggle Wave AI panel |
| `I` | Toggle Agent notification panel |
| `U` | Jump to latest unread agent notification |
| `N` / `$` / `X` | New / rename / delete workspace |
| `s` | Open workspace picker |
| `{` / `}` | Swap panes left / right |
| `?` | Open URL prompt in focused browser pane |
| `:` | Enter `wsh` command |

A **BottomBar** input component appears for prompted commands (`:`, `?`). A **WorkspacePickerModal** (`s`) lists all workspaces for fast switching.

The focused block border and resize handles now use a dedicated `--block-border-color` CSS variable (previously shared with `accent-color`), keeping the focus indicator visually distinct.

A new `app:hidewidgetpanel` setting (also toggleable from the tab bar context menu) lets you permanently hide the right-side widget panel.

---

## System Stats in Tab Bar

CPU usage, memory usage, and 1-minute load average are shown in the right side of the tab bar. Each metric is colour-coded:

| Metric | Yellow | Red |
|--------|--------|-----|
| CPU | ≥ 60 % | ≥ 85 % |
| Memory | ≥ 70 % | ≥ 90 % |
| Load avg | ≥ 1.5 × CPU count | ≥ 2 × CPU count |

Stats are polled via the existing `sysinfo` RPC and update every few seconds.

---

## Browser Block: Auto-focus URL Field

Opening a new browser block automatically focuses the URL input field so you can type an address immediately without an extra click.

---

## Agent Notification Panel

A collapsible panel on the left side of the workspace aggregates notifications from AI coding agents running in terminal panes. It surfaces completions, errors, and questions without requiring you to watch each terminal.

### Panel behaviour

- Notifications carry a **status-coloured unread background**: green (completion), yellow (question), red (error), blue (info).
- Each entry shows an `HH:MM` timestamp, the agent name, and optional branch / workdir metadata.
- Clicking a notification **focuses the originating block** and switches workspace if needed. A stored `pendingBlockFlash` key causes the block border to double-flash when the renderer loads.
- When a notification arrives and its block is visible in the current tab the block border **triple-flashes** to draw attention.
- Read state is persisted to `localStorage` and synced across renderers via storage events.
- The backend suppresses a completion notification that would overwrite a recent error (within 10 s).

### `wsh agentnotify`

Manual / scripted notifications:

```sh
wsh agentnotify "Message text" \
  --agent claude \
  --status completion|error|question|info \
  --branch "$(git branch --show-current)" \
  --workdir "$PWD" \
  --worktree "$(git rev-parse --show-toplevel)" \
  --notifyid "my-stable-id" \
  --beep
```

`--notifyid` causes an upsert — subsequent calls with the same ID update the existing entry rather than appending a new one.

---

### Claude Code configuration

**File:** `~/.claude/settings.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "wsh agenthook claude stop" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          { "type": "command", "command": "wsh agenthook claude notification" }
        ]
      },
      {
        "matcher": "elicitation_dialog",
        "hooks": [
          { "type": "command", "command": "wsh agenthook claude notification" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          { "type": "command", "command": "wsh agenthook claude notification" }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wsh agentnotify \"Task failed\" --status error --beep --workdir \"$PWD\" --branch \"$(git branch --show-current 2>/dev/null)\" --worktree \"$(git rev-parse --show-toplevel 2>/dev/null)\""
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "wsh agentnotify \"Command failed\" --status error --beep --workdir \"$PWD\" --branch \"$(git branch --show-current 2>/dev/null)\" --worktree \"$(git rev-parse --show-toplevel 2>/dev/null)\""
          }
        ]
      }
    ]
  }
}
```

`wsh agenthook claude stop` reads the Claude Code hook JSON from stdin, extracts the last assistant message for completions, and extracts the question text for `permission_prompt` / `elicitation_dialog` / `AskUserQuestion` prompts — no shell or `jq` required. It uses the originating block's ORef as a stable notify ID so each terminal pane has exactly one panel slot.

---

### opencode configuration

opencode uses a native plugin API rather than shell hooks. The plugin file is included in this repo at [`integrations/opencode/waveterm.js`](integrations/opencode/waveterm.js).

**Step 1 — copy the plugin file:**

```sh
mkdir -p ~/.config/opencode/plugins
cp integrations/opencode/waveterm.js ~/.config/opencode/plugins/waveterm.js
```

Or symlink it so it stays in sync with the repo:

```sh
ln -s "$(pwd)/integrations/opencode/waveterm.js" ~/.config/opencode/plugins/waveterm.js
```

**Step 2 — register the plugin in opencode:**

Add `"waveterm"` to the `plugins` array in `~/.config/opencode/config.json`:

```json
{
  "plugins": ["waveterm"]
}
```

opencode loads plugins by filename stem from `~/.config/opencode/plugins/`, so the name `"waveterm"` maps to `waveterm.js`.

The plugin sends a `question` notification (with a beep) when opencode asks for input, an `error` notification when a tool fails or the session errors, and a `completion` notification when the session goes idle. All notifications for a given project collapse onto a single Agent panel entry keyed by worktree path.

---

### Codex CLI configuration

Codex hooks are behind a feature flag. First enable them:

**File:** `~/.codex/config.toml`

```toml
[features]
codex_hooks = true
```

Then wire up the hook handlers:

**File:** `~/.codex/hooks.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "wsh agenthook codex stop" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "wsh agenthook codex posttooluse" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "wsh agenthook codex userpromptsubmit" }
        ]
      }
    ]
  }
}
```

What each hook does:

- `Stop` — sends the final completion notification; reclassifies as `question` or `error` when the final assistant message clearly indicates that state.
- `PostToolUse` (Bash matcher) — raises an `error` notification for high-confidence command failures.
- `UserPromptSubmit` — clears the active notification when you respond, so stale `question` / `error` states do not persist.

#### Optional: question detection via PTY wrapper

Codex does not currently expose a first-class hook for "the agent is waiting for input". To cover that gap an optional PTY wrapper watches live terminal output for approval or input prompts:

```sh
wsh agenthook codex run -- codex
```

For convenience, add a shell alias:

```sh
alias codex='wsh agenthook codex run -- codex'
```

The wrapper proxies the interactive session through a PTY (so terminal behaviour is unchanged), injects a stable notify ID so all hook events collapse onto one Agent panel entry, and emits a best-effort `question` notification with a beep when a prompt is detected.

---

## Summary of new files

| Path | Description |
|------|-------------|
| `cmd/wsh/cmd/wshcmd-agenthook.go` | `wsh agenthook` — Claude, opencode, and Codex hook handlers |
| `cmd/wsh/cmd/wshcmd-agentnotify.go` | `wsh agentnotify` — manual notification sender |
| `frontend/app/agentnotifypanel/` | Agent panel React components |
| `frontend/app/store/agentnotify.ts` | Agent notification store and read-state logic |
| `frontend/app/bottombar/` | BottomBar prompted-input component |
| `frontend/app/modals/workspacepickermodal.tsx` | Workspace picker modal |
| `frontend/app/tab/tabbar-stats.tsx` | System stats tab bar component |
| `pkg/wcore/agentnotify.go` | Backend notification dispatch and error-suppression logic |
| `pkg/baseds/agentnotify.go` | Persistent notification storage |
| `integrations/opencode/waveterm.js` | opencode plugin for agent notifications |
| `docs/docs/codex.mdx` | Codex integration documentation |
