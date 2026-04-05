/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, For } from "solid-js"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TextAttributes } from "@opentui/core"
import type { ConvergenceKVData, VerifierIssue, ConvergenceOptions } from "./types"
import { DEFAULT_OPTIONS } from "./types"
import {
  VERIFIER_SYSTEM_PROMPT,
  buildSummarizePrompt,
  buildVerificationPrompt,
  buildFixPrompt,
  parseVerifierResponse,
} from "./prompts"

const KV_PREFIX = "convergence:"

/** Minimal type for message objects returned by the SDK. */
interface SessionMessage {
  info: {
    role: "user" | "assistant"
    error?: { name?: string } | null
  }
  parts: Array<{ type: string; text?: string; status?: string; state?: { status?: string; error?: string } }>
}

interface ConvergenceDisplayState {
  active: boolean
  round: number
  maxRounds: number
  status: string
  verifierSessionID?: string
  issues: VerifierIssue[]
  startedAt: number
  processing: boolean
  lastSummary?: string
}

/** Parse issue lines from the verifier's response. */
function parseIssueLines(issuesText: string): string[] {
  const lines = issuesText.split("\n").filter((l) => l.trim())
  const issues: string[] = []
  let current = ""
  for (const line of lines) {
    if (/^\d+[\.\)]\s/.test(line.trim())) {
      if (current) issues.push(current.trim())
      current = line.trim().replace(/^\d+[\.\)]\s*/, "")
    } else {
      current += " " + line.trim()
    }
  }
  if (current) issues.push(current.trim())
  return issues.length > 0 ? issues : [issuesText.trim()]
}

const tui: TuiPlugin = async (api, options) => {
  const opts: ConvergenceOptions = {
    ...DEFAULT_OPTIONS,
    ...(options ?? {}),
  } as ConvergenceOptions

  const [state, setState] = createSignal<ConvergenceDisplayState | null>(null)
  const [dialogOpen, setDialogOpen] = createSignal(false)

  // Session todos from the coding session (tracked via todo.updated events)
  interface SessionTodo { content: string; status: string; priority: string }
  const [sessionTodos, setSessionTodos] = createSignal<SessionTodo[]>([])

  // Track managed session IDs (forks, verifiers) to ignore their idle events
  const managedSessions = new Set<string>()

  // Abort controller for the current verification run
  const [currentAbort, setCurrentAbort] = createSignal<AbortController | null>(null)

  // Track whether the coding session went busy (user sent a prompt)
  const [sessionWentBusy, setSessionWentBusy] = createSignal(false)

  // Track whether a question was dismissed/rejected during the current message
  const [questionRejected, setQuestionRejected] = createSignal(false)

  // Idle event resolvers for promptAndWait
  const idleResolvers = new Map<string, () => void>()

  /** Abort any in-flight verification/summarization and clean up. */
  function abortVerification(): void {
    const ac = currentAbort()
    if (ac) {
      ac.abort()
      setCurrentAbort(null)
    }
    // Abort running LLM in all managed sessions (forks + verifier)
    for (const sid of managedSessions) {
      api.client.session.abort({ sessionID: sid }).catch(() => {})
    }
    idleResolvers.clear()
    setSessionTodos([])
  }

  // Load custom verification instructions
  let customVerificationMd: string | undefined
  try {
    const dir = api.state.path.directory
    customVerificationMd = readFileSync(resolve(dir, ".opencode", "verification.md"), "utf-8")
  } catch { /* no custom instructions */ }

  // --- KV helpers ---

  function getKV(sessionID: string): ConvergenceKVData | undefined {
    if (!api.kv.ready) return undefined
    return api.kv.get<ConvergenceKVData | undefined>(`${KV_PREFIX}${sessionID}`, undefined)
  }

  function setKV(sessionID: string, data: ConvergenceKVData): void {
    if (!api.kv.ready) return
    api.kv.set(`${KV_PREFIX}${sessionID}`, data)
  }

  function clearKV(sessionID: string): void {
    if (!api.kv.ready) return
    api.kv.set(`${KV_PREFIX}${sessionID}`, undefined)
  }

  // --- Dialog ---

  function showVerifierDialog(): void {
    // Always re-render the dialog to reflect status changes.
    // If user dismissed with Esc (dialogOpen=false), reopen it.
    setDialogOpen(true)

    api.ui.dialog.replace(
      () => {
        const s = state()
        if (!s) return <text>No convergence data</text>

        const statusLabel = (): string => {
          switch (s.status) {
            case "summarizing": return "Summarizing session..."
            case "verifying": return "Verifier reviewing your work..."
            case "sending-fix": return "Sending fixes..."
            default: return "Starting verification..."
          }
        }

        const unresolvedIssues = (): VerifierIssue[] =>
          s.issues.filter((i) => !i.resolved)

        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
            <text attributes={TextAttributes.BOLD} fg={api.theme.current.accent}>
              {"~ Convergence Engine ~"}
            </text>
            <text fg={api.theme.current.warning ?? api.theme.current.accent}>
              {`  ${statusLabel()}`}
            </text>
            <text fg={api.theme.current.textMuted}>
              {`  Round ${s.round}/${s.maxRounds}`}
            </text>
            <Show when={unresolvedIssues().length > 0}>
              <box marginTop={1} flexDirection="column">
                <text attributes={TextAttributes.BOLD} fg={api.theme.current.error ?? api.theme.current.accent}>
                  {`  Issues from previous round (${unresolvedIssues().length}):`}
                </text>
                <For each={unresolvedIssues().slice(0, 10)}>
                  {(issue) => (
                    <text fg={api.theme.current.text}>
                      {`    [ ] ${issue.text.slice(0, 70)}`}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <Show when={sessionTodos().length > 0}>
              {(() => {
                const MAX_VISIBLE = 8
                const todos = sessionTodos()
                const completed = todos.filter((t) => t.status === "completed").length
                const active = todos.filter((t) => t.status === "in_progress" || t.status === "pending")
                const done = todos.filter((t) => t.status === "completed" || t.status === "cancelled")
                // Show active todos first, then fill remaining slots with recent completed ones
                const visible = [
                  ...active,
                  ...done.slice(-(MAX_VISIBLE - Math.min(active.length, MAX_VISIBLE))),
                ].slice(0, MAX_VISIBLE)
                return (
                  <box marginTop={1} flexDirection="column">
                    <text fg={api.theme.current.accent}>
                      {`  Verification tasks (${completed}/${todos.length} done):`}
                    </text>
                    <For each={visible}>
                      {(todo) => {
                        const icon = todo.status === "completed" ? "x"
                          : todo.status === "in_progress" ? "~"
                          : todo.status === "cancelled" ? "-"
                          : " "
                        const color = todo.status === "completed" ? api.theme.current.textMuted
                          : todo.status === "in_progress" ? (api.theme.current.warning ?? api.theme.current.accent)
                          : api.theme.current.text
                        return (
                          <text fg={color}>
                            {`    [${icon}] ${todo.content.slice(0, 65)}`}
                          </text>
                        )
                      }}
                    </For>
                    <Show when={todos.length > MAX_VISIBLE && active.length > MAX_VISIBLE}>
                      <text fg={api.theme.current.textMuted}>
                        {`    ... and ${active.length - MAX_VISIBLE} more pending`}
                      </text>
                    </Show>
                  </box>
                )
              })()}
            </Show>
            <text fg={api.theme.current.textMuted} marginTop={1}>
              {"  Press Esc to dismiss (verification continues)."}
            </text>
          </box>
        )
      },
      () => setDialogOpen(false),
    )
  }

  function hideVerifierDialog(): void {
    api.ui.dialog.clear()
    setDialogOpen(false)
  }

  function currentSessionID(): string | undefined {
    const route = api.route.current
    if (route.name === "session") {
      return (route.params as Record<string, string>)?.sessionID
    }
    return undefined
  }

  function updateState(partial: Partial<ConvergenceDisplayState>): void {
    const s = state()
    if (!s) return
    const updated = { ...s, ...partial }
    setState(updated)
    // Re-render dialog when status changes during active verification
    if (partial.status && updated.processing) {
      showVerifierDialog()
    }
  }

  // --- promptAndWait: send prompt, wait for session.idle, read response ---

  async function promptAndWait(
    targetSessionID: string,
    body: Record<string, unknown>,
    ac: AbortController,
    timeoutMs = 600_000,
  ): Promise<string> {
    idleResolvers.delete(targetSessionID)

    const idlePromise = new Promise<void>((resolve, reject) => {
      idleResolvers.set(targetSessionID, resolve)
      ac.signal.addEventListener("abort", () => {
        api.client.session.abort({ sessionID: targetSessionID }).catch(() => {})
        reject(new Error("verification cancelled"))
      }, { once: true })
    })

    await api.client.session.promptAsync({
      sessionID: targetSessionID,
      ...(body as Record<string, unknown>),
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("promptAndWait timed out")), timeoutMs)
    })

    try {
      await Promise.race([idlePromise, timeoutPromise])
    } finally {
      clearTimeout(timer)
      idleResolvers.delete(targetSessionID)
    }

    const messagesResp = await api.client.session.messages({
      sessionID: targetSessionID,
      limit: 5,
    })
    const messages = (messagesResp.data ?? []) as Array<SessionMessage>
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.info?.role === "assistant")

    if (!lastAssistant) return ""
    return lastAssistant.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
  }

  // --- Verification flow ---

  async function runVerification(sessionID: string): Promise<void> {
    const s = state()
    if (!s || !s.active || s.processing) return

    const round = s.round + 1
    if (round > s.maxRounds) {
      setState(null)
      hideVerifierDialog()
      api.ui.toast({ message: `Max rounds (${s.maxRounds}) reached`, variant: "warning" })
      return
    }

    const ac = new AbortController()
    setCurrentAbort(ac)
    let vsID: string | undefined = s.verifierSessionID
    let cancelled = false

    updateState({ round, status: "summarizing", processing: true })
    setSessionTodos([])
    showVerifierDialog()

    try {
      // Step 1: Fork and summarize
      const forkResp = await api.client.session.fork({ sessionID })
      const forkID = (forkResp.data as { id?: string })?.id
      if (!forkID) {
        setState(null)
        hideVerifierDialog()
        api.ui.toast({ message: "Convergence error: Failed to fork session", variant: "error" })
        return
      }
      managedSessions.add(forkID)

      let summaryText: string
      try {
        const summarizePrompt = buildSummarizePrompt(s.lastSummary)
        summaryText = await promptAndWait(forkID, {
          parts: [{ type: "text" as const, text: summarizePrompt, synthetic: true }],
        }, ac)
      } finally {
        managedSessions.delete(forkID)
        try { await api.client.session.delete({ sessionID: forkID }) } catch { /* ok */ }
      }

      if (ac.signal.aborted) { cancelled = true; return }
      if (!summaryText) summaryText = "(summary generation produced no output)"

      // Accumulate summaries so subsequent rounds retain full context
      const cumulativeSummary = s.lastSummary
        ? `${s.lastSummary}\n\n--- Round ${round} Delta ---\n${summaryText}`
        : summaryText
      updateState({ lastSummary: cumulativeSummary })

      // Step 2: Create or reuse verifier session
      if (!vsID) {
        let codingTitle = "session"
        try {
          const sessionResp = await api.client.session.get({ sessionID })
          codingTitle = (sessionResp.data as { title?: string })?.title ?? "session"
        } catch { /* use default */ }

        const verifierResp = await api.client.session.create({
          title: `[Verifier] ${codingTitle}`,
        })
        vsID = (verifierResp.data as { id?: string })?.id
        if (!vsID) {
          setState(null)
          hideVerifierDialog()
          api.ui.toast({ message: "Convergence error: Failed to create verifier session", variant: "error" })
          return
        }
        updateState({ verifierSessionID: vsID })
      }
      managedSessions.add(vsID)

      // Step 3: Send to verifier
      updateState({ status: "verifying" })

      const messagesResp = await api.client.session.messages({
        sessionID,
        limit: 3,
      })
      const recentMessages = (messagesResp.data ?? []) as Array<SessionMessage>
      const lastAssistant = [...recentMessages]
        .reverse()
        .find((m) => m.info.role === "assistant")
      const hasFailedTools =
        lastAssistant?.parts?.some(
          (p) => p.type === "tool" && p.status === "error",
        ) ?? false

      const verificationPrompt = buildVerificationPrompt({
        summary: summaryText,
        hasFailedTools,
        round,
        customInstructions: customVerificationMd,
        isDelta: !!s.lastSummary,
      })

      // Only send the system prompt on the first round; the verifier session
      // is persistent and retains it across subsequent messages
      const verifierBody: Record<string, unknown> = {
        parts: [{ type: "text" as const, text: verificationPrompt }],
      }
      if (!s.lastSummary) {
        verifierBody.system = VERIFIER_SYSTEM_PROMPT
      }

      const responseText = await promptAndWait(vsID, verifierBody, ac)

      if (ac.signal.aborted) { cancelled = true; return }

      if (!responseText) {
        setState(null)
        hideVerifierDialog()
        api.ui.toast({ message: "Convergence error: Verifier returned empty response", variant: "error" })
        return
      }

      const result = parseVerifierResponse(responseText)

      if (result.complete) {
        const resolved = s.issues.map((i) => ({ ...i, resolved: true }))
        if (vsID) {
          setKV(sessionID, { verifierSessionID: vsID, round, status: "converged", issues: resolved, lastSummary: state()?.lastSummary })
        }
        // Reset round counter for the next convergence run but keep active
        updateState({ round: 0, status: "idle", processing: false, issues: resolved, lastSummary: undefined })
        hideVerifierDialog()
        api.ui.toast({ message: `Convergence achieved after ${round} round${round > 1 ? "s" : ""}!`, variant: "success" })
      } else {
        // Verifier found issues
        const issueLines = parseIssueLines(result.issues)
        const newIssues: VerifierIssue[] = issueLines.map((text) => ({ round, text, resolved: false }))
        const allIssues = [...s.issues, ...newIssues]

        updateState({ status: "sending-fix", issues: allIssues })

        if (vsID) {
          setKV(sessionID, { verifierSessionID: vsID, round, status: "sending-fix", issues: allIssues, lastSummary: state()?.lastSummary })
        }

        const fixPrompt = buildFixPrompt(result.issues)
        hideVerifierDialog()

        const issueCount = issueLines.length
        api.ui.toast({
          message: `Verifier found ${issueCount} issue${issueCount > 1 ? "s" : ""} -- sending fixes`,
          variant: "warning",
        })

        // Send fix prompt -- triggers LLM response
        await api.client.session.promptAsync({
          sessionID,
          parts: [{ type: "text" as const, text: fixPrompt, synthetic: true }],
        })

        updateState({ status: "waiting-for-fix", processing: false })
      }
    } catch (err) {
      // Only real errors reach here (network failures, unexpected exceptions)
      // Cancellation is handled via the `cancelled` flag and early returns
      if (ac.signal.aborted) {
        cancelled = true
      } else {
        setState(null)
        hideVerifierDialog()
        api.ui.toast({ message: `Convergence error: ${String(err)}`, variant: "error" })
      }
    } finally {
      setCurrentAbort(null)
      if (vsID) managedSessions.delete(vsID)
      if (cancelled) {
        // Roll back round and reset to idle
        updateState({ status: "idle", processing: false, round: Math.max(0, round - 1) })
        hideVerifierDialog()
        api.ui.toast({ message: "Verification cancelled", variant: "info" })
      } else {
        const s = state()
        if (s?.processing) updateState({ processing: false })
      }
    }
  }

  // --- Event handlers ---

  // session.idle: resolve promptAndWait OR trigger verification
  const offIdle = api.event.on("session.idle", async (event) => {
    const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
    if (!sessionID) return

    // Resolve promptAndWait for managed sessions (fork/verifier)
    const resolver = idleResolvers.get(sessionID)
    if (resolver) {
      idleResolvers.delete(sessionID)
      resolver()
      return
    }

    // Ignore idle events from managed sessions
    if (managedSessions.has(sessionID)) return

    // Trigger verification for the current session
    if (sessionID !== currentSessionID()) return

    // Only trigger verification if the session went busy (user sent a prompt)
    // and the last assistant message completed without errors. This handles
    // all abort scenarios including the race condition where aborting during
    // a question/permission ask may not produce a MessageAbortedError.
    const wasBusy = sessionWentBusy()
    const wasQuestionRejected = questionRejected()
    setSessionWentBusy(false)
    setQuestionRejected(false)

    if (!wasBusy || wasQuestionRejected) return

    const s = state()
    if (!s || !s.active || s.processing) return

    // Check the last assistant message to decide if verification is warranted.
    // Skip if: the message was aborted, any tools were aborted, or no
    // substantive tool calls were made (e.g. only text responses after a
    // dismissed question or permission rejection).
    try {
      const messagesResp = await api.client.session.messages({ sessionID, limit: 3 })
      const messages = (messagesResp.data ?? []) as Array<SessionMessage>
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.info?.role === "assistant")

      if (!lastAssistant) return

      // Skip if the message has an error (MessageAbortedError, etc.)
      if (lastAssistant.info.error) return

      // Skip if any tool was aborted
      const hasAbortedTool = lastAssistant.parts.some(
        (p) => p.type === "tool" && (
          p.state?.error === "Tool execution aborted" ||
          p.status === "error"
        ),
      )
      if (hasAbortedTool) return
    } catch {
      // If we can't read messages, skip verification
      return
    }

    await runVerification(sessionID)
  })
  api.lifecycle.onDispose(offIdle)

  // session.status: track busy state for the coding session and cancel
  // verification if the user submits a new prompt while it's running
  const offStatus = api.event.on("session.status", (event) => {
    const props = (event as { properties?: { sessionID?: string; status?: { type?: string } } }).properties
    if (props?.sessionID !== currentSessionID()) return

    if (props?.status?.type === "busy") {
      setSessionWentBusy(true)
      setQuestionRejected(false)
      hideVerifierDialog()

      const s = state()
      if (s?.processing) {
        abortVerification()
      }
    }
  })
  api.lifecycle.onDispose(offStatus)

  // session.error: mark session as aborted so the next idle is skipped
  const offError = api.event.on("session.error", (event) => {
    const props = (event as { properties?: { sessionID?: string; error?: { name?: string; type?: string } } }).properties
    if (!props?.sessionID || props.sessionID !== currentSessionID()) return

    const errorName = props.error?.name ?? props.error?.type
    if (errorName === "MessageAbortedError" || errorName === "message_aborted") {
      abortVerification()
    }
  })
  api.lifecycle.onDispose(offError)

  // question.rejected: track when user dismisses a question so we skip verification
  const offQuestion = api.event.on("question.rejected", (event) => {
    const props = (event as { properties?: { sessionID?: string } }).properties
    if (props?.sessionID !== currentSessionID()) return
    setQuestionRejected(true)
  })
  api.lifecycle.onDispose(offQuestion)

  // todo.updated: track todos from managed sessions (fork/verifier)
  const offTodo = api.event.on("todo.updated", (event) => {
    const props = (event as { properties?: { sessionID?: string; todos?: SessionTodo[] } }).properties
    if (!props?.sessionID) return
    const s = state()
    if (!s?.active || props.sessionID !== s.verifierSessionID) return
    setSessionTodos(props.todos ?? [])
    // Re-render dialog if it's open to show updated todos
    if (dialogOpen()) showVerifierDialog()
  })
  api.lifecycle.onDispose(offTodo)

  /** Fetch current todos for a session via the API. */
  async function fetchSessionTodos(sessionID: string): Promise<void> {
    try {
      const resp = await api.client.session.todo({ sessionID })
      setSessionTodos((resp.data ?? []) as SessionTodo[])
    } catch {
      setSessionTodos([])
    }
  }

  // --- Commands ---

  api.command.register(() => [
    {
      title: "/converge - Toggle convergence engine",
      value: "convergence-engine.converge",
      category: "Convergence",
      slash: { name: "converge" },
      async onSelect() {
        const sessionID = currentSessionID()
        if (!sessionID) {
          api.ui.toast({ message: "No active session", variant: "warning" })
          return
        }

        const current = state()
        if (current?.active) {
          abortVerification()
          setState(null)
          hideVerifierDialog()
          api.ui.toast({ message: "Convergence engine stopped", variant: "info" })
          return
        }

        const kvData = getKV(sessionID)
        if (kvData?.verifierSessionID) {
          const openCount = kvData.issues.filter((i: VerifierIssue) => !i.resolved).length
          api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
              title="Previous verifier session found"
              options={[
                {
                  title: "Resume convergence",
                  value: "resume",
                  description: `Reuse verifier session (${kvData.round} previous round${kvData.round > 1 ? "s" : ""}, ${openCount} open issue${openCount !== 1 ? "s" : ""})`,
                },
                {
                  title: "Start fresh",
                  value: "reset",
                  description: "Delete old verifier and start new convergence",
                },
                { title: "Cancel", value: "cancel" },
              ]}
              onSelect={async (option: { value: string }) => {
                api.ui.dialog.clear()
                if (option.value === "resume") {
                  managedSessions.add(kvData.verifierSessionID)
                  setState({
                    active: true, round: 0, maxRounds: opts.maxRounds,
                    status: "idle", verifierSessionID: kvData.verifierSessionID,
                    issues: kvData.issues, startedAt: Date.now(), processing: false,
                    lastSummary: kvData.lastSummary,
                  })
                  // Hydrate verifier todos from the resumed session
                  fetchSessionTodos(kvData.verifierSessionID)
                  api.ui.toast({ message: "Convergence resumed", variant: "success" })
                } else if (option.value === "reset") {
                  try { await api.client.session.delete({ sessionID: kvData.verifierSessionID }) } catch { /* ok */ }
                  clearKV(sessionID)
                  setState({
                    active: true, round: 0, maxRounds: opts.maxRounds,
                    status: "idle", issues: [], startedAt: Date.now(), processing: false,
                  })
                  api.ui.toast({ message: "Convergence engine activated", variant: "success" })
                }
              }}
            />
          ))
          return
        }

        setState({
          active: true, round: 0, maxRounds: opts.maxRounds,
          status: "idle", issues: [], startedAt: Date.now(), processing: false,
        })
        api.ui.toast({ message: "Convergence engine activated", variant: "success" })
      },
    },
    {
      title: "/converge-status - Show convergence progress",
      value: "convergence-engine.status",
      category: "Convergence",
      slash: { name: "converge-status" },
      onSelect() {
        const s = state()
        if (!s) {
          api.ui.toast({ message: "Convergence not active", variant: "info" })
          return
        }
        api.ui.dialog.replace(() => {
          const unresolved = (): VerifierIssue[] => s.issues.filter((i) => !i.resolved)
          const resolved = (): VerifierIssue[] => s.issues.filter((i) => i.resolved)
          return (
            <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
              <text attributes={TextAttributes.BOLD} fg={api.theme.current.accent}>{"~ Convergence Status ~"}</text>
              <text fg={api.theme.current.text}>
                {`  Status: ${s.status} | Round ${s.round}/${s.maxRounds}`}
              </text>
              <Show when={s.verifierSessionID}>
                <text fg={api.theme.current.textMuted}>{`  Verifier: ${s.verifierSessionID}`}</text>
              </Show>
              <Show when={unresolved().length > 0}>
                <box marginTop={1} flexDirection="column">
                  <text attributes={TextAttributes.BOLD} fg={api.theme.current.error ?? api.theme.current.accent}>
                    {`  Open (${unresolved().length}):`}
                  </text>
                  <For each={unresolved()}>
                    {(issue) => (
                      <text fg={api.theme.current.text}>{`    [ ] R${issue.round}: ${issue.text.slice(0, 70)}`}</text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={resolved().length > 0}>
                <box marginTop={1} flexDirection="column">
                  <text fg={api.theme.current.textMuted}>{`  Resolved (${resolved().length}):`}</text>
                  <For each={resolved().slice(-5)}>
                    {(issue) => (
                      <text fg={api.theme.current.textMuted}>{`    [x] R${issue.round}: ${issue.text.slice(0, 70)}`}</text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )
        })
      },
    },
    {
      title: "/converge-reset - Reset verifier session",
      value: "convergence-engine.reset",
      category: "Convergence",
      slash: { name: "converge-reset" },
      async onSelect() {
        const sessionID = currentSessionID()
        if (!sessionID) {
          api.ui.toast({ message: "No active session", variant: "warning" })
          return
        }
        abortVerification()
        const s = state()
        if (s?.verifierSessionID) {
          try { await api.client.session.delete({ sessionID: s.verifierSessionID }) } catch { /* ok */ }
        }
        const kvData = getKV(sessionID)
        if (kvData?.verifierSessionID && kvData.verifierSessionID !== s?.verifierSessionID) {
          try { await api.client.session.delete({ sessionID: kvData.verifierSessionID }) } catch { /* ok */ }
        }
        clearKV(sessionID)
        setState(null)
        hideVerifierDialog()
        api.ui.toast({ message: "Verifier session reset", variant: "info" })
      },
    },
  ])

  // --- Sidebar: convergence status ---

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(ctx) {
        const statusColor = (): string => {
          const s = state()
          switch (s?.status) {
            case "summarizing": case "verifying": case "sending-fix": case "waiting-for-fix":
              return ctx.theme.current.warning.toString() ?? ctx.theme.current.accent.toString()
            default: return ctx.theme.current.text.toString()
          }
        }
        const label = (): string => {
          const s = state()
          if (!s) return ""
          const icon = (() => {
            switch (s.status) {
              case "summarizing": case "verifying": return "~"
              case "sending-fix": case "waiting-for-fix": return ">"
              default: return "-"
            }
          })()
          const unresolvedCount = s.issues.filter((i) => !i.resolved).length
          const parts = [`[${icon}] Convergence R${s.round}/${s.maxRounds}`]
          if (unresolvedCount > 0) parts.push(`${unresolvedCount} issues`)
          const todos = sessionTodos()
          if (todos.length > 0) {
            const done = todos.filter((t) => t.status === "completed").length
            const inProgress = todos.find((t) => t.status === "in_progress")
            if (inProgress) {
              parts.push(inProgress.content.slice(0, 30))
            } else {
              parts.push(`${done}/${todos.length} tasks`)
            }
          }
          return parts.join(" | ")
        }
        return (
          <Show when={state()}>
            <box paddingLeft={1}>
              <text fg={statusColor()}>{label()}</text>
            </box>
          </Show>
        )
      },
    },
  })
}

/** The convergence engine TUI plugin module. */
export default {
  id: "convergence-engine",
  tui,
} satisfies TuiPluginModule & { id: string }
