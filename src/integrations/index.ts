/**
 * The integration registry.
 *
 * Adding a source means writing one module and listing it here — the route,
 * the CLI command and the MCP tool are all generic over this list.
 *
 * Candidates that fit the same shape: browser bookmarks, Pocket, Letterboxd
 * (straight into the watchlist), Goodreads, X bookmarks, LinkedIn connections.
 */
import { github } from './github.js'
import type { Integration } from './types.js'

export const INTEGRATIONS: Integration[] = [github]

/** Sources whose entries are imported rather than authored. */
export const INTEGRATION_SOURCES = INTEGRATIONS.map((i) => i.id)

export function getIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id.trim().toLowerCase())
}

export function listIntegrations() {
  return INTEGRATIONS.map((i) => ({
    id: i.id,
    label: i.label,
    configured: i.configured(),
    requires: i.requires,
  }))
}

export type { Integration, SyncResult } from './types.js'
