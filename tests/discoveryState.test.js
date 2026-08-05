import { describe, it, expect } from 'vitest'
import { computeDiscoveryState, NO_PEERS_TIMEOUT_MS } from '../electron/lib/discoveryState.js'

function state(overrides = {}) {
  return computeDiscoveryState({
    hasMetadata: false,
    hasAudio: true,
    numPeers: 0,
    progress: 0,
    paused: false,
    msSinceAdded: 0,
    msSinceLastPeer: 0,
    ...overrides
  })
}

/** Convenience for the common "no peer has ever been seen" case, where
 * production code (torrents.js) initializes msSinceLastPeer === msSinceAdded
 * (both seeded from `addedAt` — see `addInternal`'s `discoveryTiming.set`). */
function neverSeenPeer(sinceMs, overrides = {}) {
  return state({ msSinceAdded: sinceMs, msSinceLastPeer: sinceMs, ...overrides })
}

describe('computeDiscoveryState', () => {
  it('exports the timeout as a named constant of ~2 minutes', () => {
    expect(NO_PEERS_TIMEOUT_MS).toBe(2 * 60 * 1000)
  })

  describe('before metadata arrives', () => {
    it('reports "searching" right after being added', () => {
      expect(neverSeenPeer(0, { hasMetadata: false })).toBe('searching')
    })

    it('stays "searching" for the whole grace period since the peer was last seen (or added, if never)', () => {
      expect(neverSeenPeer(NO_PEERS_TIMEOUT_MS - 1, { hasMetadata: false })).toBe('searching')
    })

    it('flips to "no-peers" once the grace period elapses with zero peers', () => {
      expect(neverSeenPeer(NO_PEERS_TIMEOUT_MS, { hasMetadata: false, numPeers: 0 })).toBe('no-peers')
      expect(neverSeenPeer(NO_PEERS_TIMEOUT_MS + 60_000, { hasMetadata: false, numPeers: 0 })).toBe('no-peers')
    })

    it('reports "connected" the instant a peer is present, even before the grace period elapses', () => {
      expect(neverSeenPeer(500, { hasMetadata: false, numPeers: 1 })).toBe('connected')
    })

    it('recovers from "no-peers" back to "connected" the instant a peer reappears (no latching)', () => {
      expect(neverSeenPeer(NO_PEERS_TIMEOUT_MS * 5, { hasMetadata: false, numPeers: 0 })).toBe('no-peers')
      expect(neverSeenPeer(NO_PEERS_TIMEOUT_MS * 5, { hasMetadata: false, numPeers: 3 })).toBe('connected')
    })

    // MINOR 2 fix (review round): hysteresis via msSinceLastPeer, not raw
    // msSinceAdded (which never resets and would otherwise flap
    // connected/no-peers on every single peer blip past the grace period).
    describe('peer-recency hysteresis (does not flap on a peer blip)', () => {
      it('does NOT immediately report "no-peers" right after a peer blip, even though msSinceAdded is far past the grace period', () => {
        // Added long ago (way past the grace period), but a peer was seen
        // moments ago — e.g. connected briefly, then dropped straight back
        // to zero, with metadata still never having arrived.
        expect(
          state({ hasMetadata: false, numPeers: 0, msSinceAdded: NO_PEERS_TIMEOUT_MS * 20, msSinceLastPeer: 500 })
        ).toBe('searching')
      })

      it('is now driven purely by msSinceLastPeer in this branch — msSinceAdded alone no longer matters', () => {
        // Same huge msSinceAdded in both cases; only msSinceLastPeer differs.
        expect(
          state({ hasMetadata: false, numPeers: 0, msSinceAdded: NO_PEERS_TIMEOUT_MS * 20, msSinceLastPeer: 0 })
        ).toBe('searching')
        expect(
          state({
            hasMetadata: false,
            numPeers: 0,
            msSinceAdded: NO_PEERS_TIMEOUT_MS * 20,
            msSinceLastPeer: NO_PEERS_TIMEOUT_MS
          })
        ).toBe('no-peers')
      })

      it('eventually re-flips to "no-peers" once the FULL grace period has re-elapsed since that last blip', () => {
        expect(
          state({ hasMetadata: false, numPeers: 0, msSinceAdded: NO_PEERS_TIMEOUT_MS * 20, msSinceLastPeer: NO_PEERS_TIMEOUT_MS - 1 })
        ).toBe('searching')
        expect(
          state({ hasMetadata: false, numPeers: 0, msSinceAdded: NO_PEERS_TIMEOUT_MS * 20, msSinceLastPeer: NO_PEERS_TIMEOUT_MS })
        ).toBe('no-peers')
      })
    })
  })

  describe('after metadata arrives', () => {
    it('reports "connected" as soon as metadata arrives, before any stall timeout', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 0.1, msSinceLastPeer: 0 })).toBe('connected')
    })

    it('stays "connected" while within the no-peers grace period, mid-download', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 0.4, msSinceLastPeer: NO_PEERS_TIMEOUT_MS - 1 })).toBe(
        'connected'
      )
    })

    it('flips to "no-peers" once zero peers persist past the timeout with progress < 1 (stalled mid-download)', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 0.4, msSinceLastPeer: NO_PEERS_TIMEOUT_MS })).toBe(
        'no-peers'
      )
    })

    it('flips to "no-peers" the same way even at progress 0 (metadata arrived but nothing ever downloaded)', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 0, msSinceLastPeer: NO_PEERS_TIMEOUT_MS + 1 })).toBe(
        'no-peers'
      )
    })

    it('never reports "no-peers" once progress reaches 1 — a finished download does not need seeders', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 1, msSinceLastPeer: NO_PEERS_TIMEOUT_MS * 100 })).toBe(
        'connected'
      )
    })

    it('recovers out of a stalled "no-peers" back to "connected" the instant a peer reappears', () => {
      expect(state({ hasMetadata: true, numPeers: 0, progress: 0.2, msSinceLastPeer: NO_PEERS_TIMEOUT_MS * 3 })).toBe(
        'no-peers'
      )
      expect(state({ hasMetadata: true, numPeers: 2, progress: 0.2, msSinceLastPeer: NO_PEERS_TIMEOUT_MS * 3 })).toBe(
        'connected'
      )
    })

    // MINOR 1 fix (review round): a no-audio torrent has nothing to ever
    // download, so an empty swarm is never "stuck" for discovery purposes.
    describe('no-audio exemption', () => {
      it('never reports "no-peers" once metadata has arrived and hasAudio is false, no matter how long peers are absent', () => {
        expect(
          state({ hasMetadata: true, hasAudio: false, numPeers: 0, progress: 0, msSinceLastPeer: NO_PEERS_TIMEOUT_MS * 50 })
        ).toBe('connected')
      })

      it('is "connected" immediately once metadata arrives for a no-audio torrent, not just eventually', () => {
        expect(state({ hasMetadata: true, hasAudio: false, numPeers: 0, progress: 0, msSinceLastPeer: 0 })).toBe(
          'connected'
        )
      })

      it('defaults hasAudio to true when omitted, preserving prior behavior for existing callers', () => {
        expect(
          state({ hasMetadata: true, numPeers: 0, progress: 0.2, msSinceLastPeer: NO_PEERS_TIMEOUT_MS, hasAudio: undefined })
        ).toBe('no-peers')
      })

      it('does not apply the no-audio exemption before metadata has arrived (hasAudio is only meaningful post-metadata)', () => {
        // hasAudio: false here is meaningless pre-metadata (we don't know
        // the manifest yet) — the ordinary pre-metadata timeout still runs.
        expect(
          state({ hasMetadata: false, hasAudio: false, numPeers: 0, msSinceAdded: NO_PEERS_TIMEOUT_MS, msSinceLastPeer: NO_PEERS_TIMEOUT_MS })
        ).toBe('no-peers')
      })
    })
  })

  describe('paused exemption', () => {
    it('never reports "no-peers" while paused, no matter how long it has been searching (no metadata)', () => {
      expect(
        neverSeenPeer(NO_PEERS_TIMEOUT_MS * 10, { hasMetadata: false, numPeers: 0, paused: true })
      ).toBe('searching')
    })

    it('never reports "no-peers" while paused, no matter how long it has been stalled (metadata arrived)', () => {
      expect(
        state({ hasMetadata: true, numPeers: 0, progress: 0.3, paused: true, msSinceLastPeer: NO_PEERS_TIMEOUT_MS * 10 })
      ).toBe('connected')
    })

    it('un-pausing re-applies the timeout immediately (no lingering exemption)', () => {
      expect(
        neverSeenPeer(NO_PEERS_TIMEOUT_MS * 10, { hasMetadata: false, numPeers: 0, paused: false })
      ).toBe('no-peers')
    })
  })
})
