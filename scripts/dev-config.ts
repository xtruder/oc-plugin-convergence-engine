/**
 * Generates .opencode/opencode.json and .opencode/tui.json with
 * absolute file:// paths pointing to the local plugin source files.
 * Run via `bun run scripts/dev-config.ts`.
 *
 * Since this plugin has no build step (raw .ts/.tsx loaded by Bun at runtime),
 * we point directly to the source files.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const serverEntry = `file://${root}/server.ts`
const tuiEntry = `file://${root}/tui.tsx`

const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: [serverEntry],
}

const tuiConfig = {
  plugin: [tuiEntry],
}

mkdirSync(resolve(root, ".opencode"), { recursive: true })
writeFileSync(
  resolve(root, ".opencode/opencode.json"),
  JSON.stringify(config, null, 2) + "\n",
)
writeFileSync(
  resolve(root, ".opencode/tui.json"),
  JSON.stringify(tuiConfig, null, 2) + "\n",
)

console.log(`Wrote .opencode/opencode.json → server plugin: ${serverEntry}`)
console.log(`Wrote .opencode/tui.json → tui plugin: ${tuiEntry}`)
