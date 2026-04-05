/**
 * Adversarial verification prompt sent to a SEPARATE verifier session.
 * The verifier receives an LLM-generated summary (from a forked session)
 * and must actively look for problems rather than confirm success.
 */
export const VERIFIER_SYSTEM_PROMPT = `You are an independent code auditor and task verifier. Your job is to critically evaluate whether a task has been completed correctly and thoroughly.

You must be SKEPTICAL by default. Assume the work is incomplete until you can confirm otherwise through concrete evidence. Do not take the original assistant's claims at face value.

Your verification process:
1. Read the original task requirements carefully
2. Examine every file that was created or modified
3. Look for: missing requirements, incomplete implementations, errors, edge cases not handled, tests not written, build/lint issues
4. Run any available verification commands (tests, type checks, builds) to confirm correctness
5. Check that the output matches what was actually requested, not just what's close enough

IMPORTANT: Use the TodoWrite tool to track your verification progress. Create a todo for each verification step you plan to perform and update their status as you work through them. This gives visibility into what you are checking and how far along you are.

You are NOT the assistant that did the work. You are the reviewer. Be thorough and honest.`

/**
 * Prompt sent to a FORKED copy of the worker session to generate
 * a structured summary of the work done. The fork has full conversation
 * context, so the LLM can produce a proper summary.
 *
 * On round 1, produces a full summary. On subsequent rounds, receives the
 * previous summary and only outputs what changed since then.
 */
export function buildSummarizePrompt(previousSummary?: string): string {
  if (!previousSummary) {
    return `Summarize everything that happened in this session for an independent code reviewer. Be factual and specific. Include:

1. **Original task**: What was the user's request?
2. **Actions taken**: What files were created, modified, or deleted? What commands were run?
3. **Current state**: What is the current state of the work? What exists on disk now?
4. **Open issues**: Were there any errors, failed tool calls, or unresolved problems?
5. **Completion claim**: Did you indicate the task was finished, or were you still working?

Be honest and include anything that went wrong or was left incomplete. Do not editorialize or justify -- just report the facts.`
  }

  return `An independent code reviewer already has the following summary of this session from a previous verification round:

<previous-summary>
${previousSummary}
</previous-summary>

Your job is to produce a **delta summary** -- only describe what changed SINCE that summary was written. Focus on:

1. **New actions**: What files were created, modified, or deleted since the previous summary? What new commands were run?
2. **Fixes applied**: What issues from the previous round were addressed, and how?
3. **Remaining issues**: Are there any new errors, failed tool calls, or unresolved problems?
4. **Current state**: Has the overall state changed? Is the work now complete?

Do NOT repeat information already in the previous summary. Only report new or changed facts. Be concise and factual.`
}

/**
 * The prompt sent to the verifier session for each verification round.
 * Receives an LLM-generated summary from the forked session.
 */
export function buildVerificationPrompt(input: {
  summary: string
  hasFailedTools: boolean
  round: number
  customInstructions?: string
  isDelta?: boolean
}): string {
  const parts: string[] = []

  parts.push(`## Verification Round ${input.round}`)
  parts.push("")
  if (input.isDelta) {
    parts.push(`### Changes Since Last Round`)
    parts.push(`The following describes only what changed since the previous verification round:`)
  } else {
    parts.push(`### Session Summary`)
  }
  parts.push(input.summary)
  parts.push("")

  if (input.hasFailedTools) {
    parts.push(
      `**WARNING**: Some tool calls failed during the previous round. Pay special attention to whether the failures were recovered from.`,
    )
    parts.push("")
  }

  if (input.customInstructions) {
    parts.push(`### Additional Verification Criteria`)
    parts.push(input.customInstructions)
    parts.push("")
  }

  parts.push(`### Your Task`)
  parts.push(
    `Verify whether the original task has been fully and correctly completed. Be adversarial -- actively look for problems, missing pieces, and things that could be wrong.`,
  )
  parts.push("")
  parts.push(`Specifically check:`)
  parts.push(`1. Are ALL requirements from the original task addressed?`)
  parts.push(
    `2. Were any files that should have been created/modified missed?`,
  )
  parts.push(`3. Are there syntax errors, type errors, or broken imports?`)
  parts.push(
    `4. If tests were expected, do they exist and would they pass?`,
  )
  parts.push(`5. Are there any obvious bugs or logic errors?`)
  parts.push(
    `6. Is the implementation complete or are there TODOs/placeholders left?`,
  )
  parts.push("")
  parts.push(
    `After your analysis, you MUST end your response with exactly one of:`,
  )
  parts.push("")
  parts.push(
    `[CONVERGENCE:COMPLETE] - ONLY if you found zero issues after thorough review`,
  )
  parts.push(
    `[CONVERGENCE:ISSUES] - If you found ANY issues, followed by a numbered list of specific problems that need fixing`,
  )

  return parts.join("\n")
}

/**
 * Prompt sent back to the ORIGINAL session when the verifier finds issues.
 * Tells the worker to fix the specific problems identified.
 */
export function buildFixPrompt(issues: string): string {
  return `The convergence engine's independent verifier found the following issues with your work. Fix all of them:

${issues}

After fixing everything, confirm what you fixed.`
}

/**
 * Parse the verifier's response. The verifier uses [CONVERGENCE:COMPLETE]
 * or [CONVERGENCE:ISSUES] markers.
 */
export function parseVerifierResponse(text: string): {
  complete: boolean
  issues: string
} {
  const completeMatch = text.includes("[CONVERGENCE:COMPLETE]")
  const issuesMatch = text.includes("[CONVERGENCE:ISSUES]")

  if (completeMatch && !issuesMatch) {
    return { complete: true, issues: "" }
  }

  // Extract everything after [CONVERGENCE:ISSUES]
  const issuesIdx = text.indexOf("[CONVERGENCE:ISSUES]")
  if (issuesIdx !== -1) {
    const issues = text.slice(issuesIdx + "[CONVERGENCE:ISSUES]".length).trim()
    return { complete: false, issues }
  }

  // No marker found -- treat as incomplete with the whole response as context
  return { complete: false, issues: text }
}
