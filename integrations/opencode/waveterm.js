// WaveTerm agent notification plugin for opencode.
//
// Sends terminal notifications to the WaveTerm Agent panel via `wsh agentnotify`
// so you only see actionable end-of-turn state.
//
// Installation
// ------------
// 1. Copy (or symlink) this file to ~/.config/opencode/plugins/waveterm.js
// 2. In ~/.config/opencode/config.json, add the plugin to the plugins array:
//
//      {
//        "plugins": ["waveterm"]
//      }
//
// Requires: wsh in PATH (installed automatically with WaveTerm).
// The plugin silently no-ops when run outside a WaveTerm session.

export const WavetermPlugin = async ({ $, worktree }) => {
  let lastText = ""
  // Stable notify ID so "question" → "completion" updates the same panel entry.
  // One slot per project (worktree), matching how Claude Code uses one slot per pane.
  const notifyId = `opencode:${worktree || "default"}`

  async function getBranch() {
    if (!worktree) return ""
    try {
      return (await $`git -C ${worktree} branch --show-current`.text()).trim()
    } catch {
      return ""
    }
  }

  function truncate(text, max) {
    const collapsed = text.replace(/\s+/g, " ").trim()
    return [...collapsed].slice(0, max).join("")
  }

  async function sendNotify(message, status, { beep = false, lifecycle = "terminal" } = {}) {
    const branch = await getBranch()
    const args = ["agentnotify", "--agent", "opencode", "--status", status, "--lifecycle", lifecycle, "--notifyid", notifyId]
    if (worktree) {
      args.push("--workdir", worktree, "--worktree", worktree)
    }
    if (branch) {
      args.push("--branch", branch)
    }
    if (beep) {
      args.push("--beep")
    }
    args.push(message)
    try {
      await $`wsh ${args}`
    } catch {
      // wsh not available or not inside a WaveTerm session — silently ignore
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "question.asked") {
        const q = event.properties?.questions?.[0]
        const text = q?.question || q?.header || "Input required"
        await sendNotify(truncate(text, 300), "question", { beep: true })
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part
        if (part?.type === "text" && part?.text) {
          lastText = part.text
        }
        if (part?.type === "tool" && part?.state?.status === "error") {
          const text = truncate(part.state.error || "Tool error", 300)
          await sendNotify(text, "error", { lifecycle: "intermediate" })
        }
        if (part?.type === "tool" && part?.state?.status === "completed") {
          const s = part.state
          const exit = s.metadata?.exit
          if (exit !== undefined && exit !== 0) {
            const text = truncate((s.output || `Exit code ${exit}`).trim(), 300)
            await sendNotify(text, "error", { lifecycle: "intermediate" })
          }
        }
      }

      if (event.type === "session.idle") {
        const message = truncate(lastText || "Session complete", 300)
        lastText = ""
        await sendNotify(message, "completion")
      }

      if (event.type === "session.error") {
        const errMsg = event.properties?.error?.message || "Session error"
        lastText = ""
        await sendNotify(truncate(errMsg, 300), "error")
      }
    },
  }
}
