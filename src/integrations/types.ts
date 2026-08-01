/**
 * Integrations pull things you have already collected somewhere else — starred
 * repos, saved films, bookmarked articles — into flow so they are recallable
 * alongside everything you wrote yourself.
 *
 * Two rules shape the whole design:
 *
 *   1. **Imported is not authored.** A star is a weak signal; you starred 51
 *      things and thought hard about three. Imports must never crowd out the
 *      memories you actually wrote, so they stay out of the briefing until you
 *      say something about them.
 *   2. **Sync is idempotent.** Every imported item carries a stable
 *      `capture_id` of the form `<source>:<type>:<external id>`, so re-syncing
 *      updates in place and can be run as often as you like. This is the same
 *      mechanism device clients use for offline retries.
 */

export interface SyncResult {
  source: string
  imported: number
  /** Already present, left alone. */
  skipped: number
  total_seen: number
  note?: string
}

export interface Integration {
  /** Stable id, used in routes and as the capture_id prefix. */
  readonly id: string
  readonly label: string
  /** What it needs before it can run, for a useful "not configured" message. */
  readonly requires: string
  configured(): boolean
  sync(opts?: { limit?: number }): Promise<SyncResult>
}
