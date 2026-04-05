# Convergence Engine - OpenCode Plugin

An OpenCode plugin that automatically verifies LLM-generated work by running an independent verifier session after each coding task completes.

## Architecture

The plugin runs entirely in the TUI process. The server plugin (`server.ts`) is a stub.

- `tui.tsx` -- All verification logic, UI (dialog, sidebar, commands), state management, and session orchestration
- `prompts.ts` -- Prompt templates for summarization, verification, and fix generation
- `types.ts` -- Shared type definitions (ConvergenceStatus, VerifierIssue, ConvergenceOptions, ConvergenceKVData)
- `server.ts` -- Empty stub to satisfy package.json exports

## Verification Flow

1. User activates `/converge` -- sets local TUI state to active
2. When `session.idle` fires, TUI forks the coding session and asks the fork to summarize the work
3. Summary is sent to a persistent verifier session for adversarial review
4. If verifier finds issues, a fix prompt is sent back to the coding session
5. If verifier says complete, convergence is achieved
6. The cycle repeats on each `session.idle` until converged or max rounds reached

## Key Patterns

- `promptAndWait()` -- sends a prompt via `api.client.session.promptAsync()`, registers an idle event resolver, waits for `session.idle` to fire for that session, then reads the last assistant message
- `managedSessions` Set -- tracks fork and verifier session IDs to prevent their idle events from triggering new verification rounds
- `AbortController` -- cancels in-flight verification when user sends a new message, disables convergence, or resets
- KV persistence -- stores verifier session ID and issues per coding session for resume/reset across TUI restarts

## Custom Verification Instructions

Place a `verification.md` file in `.opencode/` to add project-specific verification criteria. The content is appended to the verifier's prompt.

## Commands

- `/converge` -- Toggle convergence engine on/off
- `/converge-status` -- Show detailed progress dialog
- `/converge-reset` -- Delete verifier session and reset state
