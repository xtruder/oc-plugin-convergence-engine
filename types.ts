/** Possible status values for the convergence engine state machine. */
export type ConvergenceStatus =
  | "idle"
  | "summarizing"
  | "verifying"
  | "sending-fix"
  | "waiting-for-fix"
  | "converged"
  | "max-rounds"
  | "error"

/** A single issue found by the verifier during a verification round. */
export interface VerifierIssue {
  /** The round in which this issue was found. */
  round: number
  /** Human-readable description of the issue. */
  text: string
  /** Whether this issue has been resolved in a subsequent round. */
  resolved: boolean
}

/** Configuration options for the convergence engine. */
export interface ConvergenceOptions {
  enabled: boolean
  maxRounds: number
  autoStart: boolean
  verificationPrompt?: string
}

/** Default convergence options used when no user overrides are provided. */
export const DEFAULT_OPTIONS: ConvergenceOptions = {
  enabled: true,
  maxRounds: 5,
  autoStart: false,
}

/** Shape of the data stored in TUI KV for a convergence mapping. */
export interface ConvergenceKVData {
  verifierSessionID: string
  round: number
  status: ConvergenceStatus
  issues: VerifierIssue[]
  lastSummary?: string
}
