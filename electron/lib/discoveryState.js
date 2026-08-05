// Pure decision logic for a torrent's peer-discovery status, surfaced on
// `torrents:list`/`torrents:progress` (see torrents.js's `summarize()`) as
// the `discovery` field. This is purely a status signal for the renderer to
// explain an otherwise-silent stuck download (e.g. a magnet whose trackers
// are all dead and DHT finds nothing) — nothing here ever pauses or removes
// a torrent; the user decides what to do.
//
// Extracted into its own pure function (no Date.now(), no torrent object)
// so the state machine — including recovery and the paused exemption — can
// be unit-tested deterministically without a real webtorrent client.

/** How long a torrent may sit with zero peers before it's reported as
 * 'no-peers' instead of 'searching'/'connected'. Applies both to "never
 * found the swarm at all" (no metadata yet) and "found peers once but they
 * vanished mid-download" (metadata arrived, stalled). */
export const NO_PEERS_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes

/**
 * @param {object} input
 * @param {boolean} input.hasMetadata - true once the torrent's file list is
 *   known (webtorrent's 'metadata' event has fired for this torrent).
 * @param {boolean} [input.hasAudio] - true if the classified manifest
 *   contains any audio at all (defaults to `true`, so existing callers that
 *   don't pass it — and every state before metadata arrives, where this is
 *   irrelevant — are unaffected). Only consulted once `hasMetadata` is true.
 * @param {number} input.numPeers - current live peer count.
 * @param {number} input.progress - selected-audio download progress, 0..1.
 * @param {boolean} input.paused - true if the user has paused this torrent.
 * @param {number} input.msSinceAdded - ms since the torrent was added.
 * @param {number} input.msSinceLastPeer - ms since numPeers was last > 0
 *   (equal to msSinceAdded if it never has been).
 * @returns {'searching'|'no-peers'|'connected'}
 *
 * States:
 *   'searching'  — added, metadata not yet arrived, still within the grace
 *                  period (NO_PEERS_TIMEOUT_MS) since the torrent was last
 *                  seen with zero peers.
 *   'no-peers'   — no metadata AND zero peers for a sustained period, OR
 *                  metadata has arrived (with audio to fetch) but the
 *                  download is stalled: zero peers for a sustained period
 *                  with progress still < 1. (Same signal for both — the UI
 *                  is expected to tell them apart purely from `progress`:
 *                  0 vs >0.)
 *   'connected'  — has a peer right now, OR metadata has arrived and either
 *                  there's no audio to fetch at all, progress is already
 *                  complete (nothing left to fetch, so an empty swarm isn't
 *                  a problem), or the no-peers grace period hasn't elapsed.
 *
 * Recovery: `numPeers > 0` is checked first and short-circuits straight to
 * 'connected' regardless of how long the torrent was previously starved —
 * this never latches into 'no-peers' permanently once real peers reconnect.
 * The pre-metadata branch uses the same `msSinceLastPeer` hysteresis as the
 * post-metadata branch (not `msSinceAdded`, which never resets) so a magnet
 * whose peers blip in and out without metadata ever arriving doesn't flap
 * connected/no-peers on every single blip — it gets the same fresh
 * NO_PEERS_TIMEOUT_MS countdown from the last time a peer was actually seen.
 *
 * Paused exemption: a paused torrent never reports 'no-peers' — the user
 * paused it on purpose, it isn't "stuck", and pausing stops active
 * discovery, so a timeout firing here would be misleading.
 *
 * No-audio exemption: a torrent whose manifest has no audio at all has
 * nothing this app will ever download (deliberately — see torrents.js's
 * module header); an empty swarm isn't "stuck", it's irrelevant. The
 * renderer already has a dedicated no-audio state for this and shouldn't
 * also claim a peer problem, so this is always 'connected' once metadata
 * is known, never 'no-peers'.
 */
export function computeDiscoveryState({
  hasMetadata,
  hasAudio = true,
  numPeers,
  progress,
  paused,
  msSinceAdded,
  msSinceLastPeer
}) {
  if (paused) return hasMetadata ? 'connected' : 'searching'

  if (numPeers > 0) return 'connected'

  if (!hasMetadata) {
    return msSinceLastPeer >= NO_PEERS_TIMEOUT_MS ? 'no-peers' : 'searching'
  }

  if (!hasAudio) return 'connected'

  // Metadata is known and there's audio to fetch: normally 'connected'
  // (actively transferring, or just momentarily between peers) unless
  // already fully downloaded, or peers have been absent long enough to
  // call it stalled.
  if (progress >= 1) return 'connected'
  return msSinceLastPeer >= NO_PEERS_TIMEOUT_MS ? 'no-peers' : 'connected'
}
