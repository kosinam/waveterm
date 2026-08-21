// WaveTerm agent notification plugin for opencode.
//
// Sends terminal notifications to the WaveTerm Agent panel via `wsh agentnotify`
// so you only see actionable end-of-turn state.
//
// Installation
// ------------
// Copy (or symlink) this file to ~/.config/opencode/plugins/waveterm.js.
// OpenCode discovers files in that directory automatically.
//
// Requires: wsh in PATH (installed automatically with WaveTerm).
// The plugin silently no-ops when run outside a WaveTerm session.

export const WavetermPlugin = async ({ $, worktree }) => {
  const lastText = new Map()
  const childSessions = new Set()
  const sessionTitles = new Map()
  let mainSessionId = null

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

  function getDisplayDir(dir) {
    if (!dir) return ""
    const home = process.env.HOME
    if (home && (dir === home || dir.startsWith(home + "/"))) {
      return "~" + dir.slice(home.length)
    }
    return dir
  }

  async function setTerminalTitle(title) {
    const displayDir = getDisplayDir(worktree || process.cwd())
    const frameText = title ? stringsJoin(displayDir, `(${title})`) : ""
    try {
      if (frameText) {
        await $`wsh setmeta frame:text=${frameText}`
      } else {
        await $`wsh setmeta frame:text=null`
      }
    } catch {
      // wsh not available or not inside a WaveTerm session — silently ignore
    }
  }

  function stringsJoin(dir, topic) {
    return dir ? `${dir} ${topic}` : topic
  }

  function getTopic(sessionID) {
    return (sessionID && sessionTitles.get(sessionID)) || (mainSessionId && sessionTitles.get(mainSessionId)) || ""
  }

  function formatToolDescription(tool, input, title) {
    if (title) return truncate(title, 80)
    if (!input || typeof input !== "object") return tool
    if (tool === "bash" && input.command) {
      return `bash: ${truncate(String(input.command), 70)}`
    }
    if ((tool === "read" || tool === "edit" || tool === "write") && input.filePath) {
      return `${tool}: ${truncate(String(input.filePath), 70)}`
    }
    if (tool === "glob" && input.pattern) {
      return `glob: ${truncate(String(input.pattern), 70)}`
    }
    if (tool === "grep" && input.pattern) {
      return `grep: ${truncate(String(input.pattern), 70)}`
    }
    return tool
  }

  async function sendNotify(message, status, { beep = false, lifecycle = "terminal", topic = "" } = {}) {
    const branch = await getBranch()
    const args = ["agentnotify", "--agent", "opencode", "--status", status, "--lifecycle", lifecycle]
    if (worktree) {
      args.push("--workdir", worktree, "--worktree", worktree)
    }
    if (branch) {
      args.push("--branch", branch)
    }
    if (topic) {
      args.push("--topic", topic)
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
      if (event.type === "session.created") {
        const info = event.properties?.info
        if (info?.parentID) {
          childSessions.add(info.id)
        } else if (info?.id) {
          mainSessionId = info.id
          if (info.title && info.title !== "New session") {
            sessionTitles.set(info.id, info.title)
            await setTerminalTitle(info.title)
          }
        }
      }

      if (event.type === "session.updated") {
        const info = event.properties?.info
        if (info?.id && !childSessions.has(info.id)) {
          if (!mainSessionId) mainSessionId = info.id
          if (info.title && info.title !== sessionTitles.get(info.id)) {
            sessionTitles.set(info.id, info.title)
            await setTerminalTitle(info.title)
          }
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = event.properties?.info?.id
        if (sessionID) {
          childSessions.delete(sessionID)
          lastText.delete(sessionID)
          sessionTitles.delete(sessionID)
          if (sessionID === mainSessionId) {
            mainSessionId = null
            await setTerminalTitle("")
          }
        }
      }

      if (event.type === "session.status") {
        const sessionID = event.properties?.sessionID
        if (sessionID && childSessions.has(sessionID)) return
        const status = event.properties?.status
        if (status?.type === "busy") {
          const topic = getTopic(sessionID)
          await sendNotify("Working...", "info", { lifecycle: "intermediate", topic })
        }
      }

      if (event.type === "question.asked") {
        const q = event.properties?.questions?.[0]
        const text = q?.question || q?.header || "Input required"
        const topic = getTopic()
        await sendNotify(truncate(text, 300), "question", { beep: true, topic })
      }

      if (event.type === "permission.asked") {
        const permission = event.properties?.permission || "Permission"
        const pattern = event.properties?.patterns?.[0]
        const text = pattern ? `${permission}: ${pattern}` : `${permission} permission required`
        const topic = getTopic()
        await sendNotify(truncate(text, 300), "question", { beep: true, topic })
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part
        if (part?.sessionID && childSessions.has(part.sessionID)) return

        if (part?.type === "text" && part?.text) {
          lastText.set(part.sessionID, part.text)
        }
        if (part?.type === "tool" && part?.state?.status === "running") {
          const topic = getTopic(part.sessionID)
          const desc = formatToolDescription(part.tool, part.state.input, part.state.title)
          await sendNotify(desc, "info", { lifecycle: "intermediate", topic })
        }
        if (part?.type === "tool" && part?.state?.status === "error") {
          const topic = getTopic(part.sessionID)
          const text = truncate(part.state.error || "Tool error", 300)
          await sendNotify(text, "error", { lifecycle: "intermediate", topic })
        }
        if (part?.type === "tool" && part?.state?.status === "completed") {
          const s = part.state
          const exit = s.metadata?.exit
          if (exit !== undefined && exit !== 0) {
            const topic = getTopic(part.sessionID)
            const text = truncate((s.output || `Exit code ${exit}`).trim(), 300)
            await sendNotify(text, "error", { lifecycle: "intermediate", topic })
          }
        }
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (sessionID && childSessions.has(sessionID)) {
          lastText.delete(sessionID)
          return
        }
        const message = truncate((sessionID && lastText.get(sessionID)) || "Session complete", 300)
        if (sessionID) lastText.delete(sessionID)
        const topic = getTopic(sessionID)
        await sendNotify(message, "completion", { topic })
      }

      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID
        const errMsg = event.properties?.error?.message || "Session error"
        if (sessionID) lastText.delete(sessionID)
        const topic = getTopic(sessionID)
        await sendNotify(truncate(errMsg, 300), "error", { topic })
      }
    },
  }
}
