import type { Plugin, PluginModule } from "@opencode-ai/plugin"

/**
 * Server plugin stub. The convergence engine runs entirely in the TUI plugin.
 * This file exists to satisfy the package.json exports for ./server.
 */
const server: Plugin = async () => {
  return {}
}

/** The convergence engine server plugin module (stub -- logic is in TUI). */
export default {
  id: "convergence-engine",
  server,
} satisfies PluginModule & { id: string }
