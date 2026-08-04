// electron/lib/scanQueue.js
//
// Generic rate-limited, deduping, retry-with-backoff request queue used to
// serialize VirusTotal hash lookups (docs/PLAN4B.md). Deliberately generic
// (doesn't know about VirusTotal, hashes-as-such, or Electron) — the caller
// supplies `performLookup(key)`; anything that returns `{status:
// 'rate-limited', retryAfterMs}` triggers backoff+requeue, everything else
// resolves. Time is fully injectable via a `clock` of
// `{now, setTimeout, clearTimeout}` so scheduling/backoff is unit-testable
// without real timers.

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 4
export const DEFAULT_REQUEST_INTERVAL_MS = Math.ceil(60000 / DEFAULT_RATE_LIMIT_PER_MINUTE)
export const MAX_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes, per docs/PLAN4B.md

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id)
}

/**
 * @param {object} opts
 * @param {(key: string) => Promise<object>} opts.performLookup - perform ONE
 *   lookup for a given key. A `{status: 'rate-limited', retryAfterMs}`
 *   result triggers exponential backoff and requeues the key (never
 *   dropped); anything else (including a thrown/rejected error) settles
 *   every waiter for that key.
 * @param {number} [opts.requestIntervalMs] - minimum spacing between
 *   dispatched requests (the rate limit itself).
 * @param {{now:Function, setTimeout:Function, clearTimeout:Function}} [opts.clock]
 *   injectable for tests; defaults to real timers/Date.now.
 */
export function createScanQueue({ performLookup, requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS, clock = REAL_CLOCK }) {
  const queue = [] // FIFO of keys awaiting dispatch (a key appears at most once)
  const waitersByKey = new Map() // key -> [{resolve, reject}] — dedupe: same key queued twice just adds a waiter
  const backoffByKey = new Map() // key -> current backoff ms, only present while that key has been rate-limited at least once
  let timerId = null
  let nextAllowedAt = clock.now()

  function ensureTimer() {
    if (timerId !== null || queue.length === 0) return
    const delay = Math.max(0, nextAllowedAt - clock.now())
    timerId = clock.setTimeout(() => {
      timerId = null
      dispatchNext()
    }, delay)
  }

  async function dispatchNext() {
    const key = queue.shift()
    if (key === undefined) return

    let result
    try {
      result = await performLookup(key)
    } catch (err) {
      settleKey(key, null, err)
      nextAllowedAt = clock.now() + requestIntervalMs
      ensureTimer()
      return
    }

    if (result?.status === 'rate-limited') {
      const previousBackoff = backoffByKey.get(key) || requestIntervalMs
      const doubled = previousBackoff * 2
      const suggested = typeof result.retryAfterMs === 'number' ? result.retryAfterMs : 0
      const nextBackoff = Math.min(Math.max(doubled, suggested), MAX_BACKOFF_MS)
      backoffByKey.set(key, nextBackoff)
      queue.push(key) // requeue at the back — never dropped
      nextAllowedAt = clock.now() + nextBackoff
      ensureTimer()
      return
    }

    settleKey(key, result, null)
    nextAllowedAt = clock.now() + requestIntervalMs
    ensureTimer()
  }

  function settleKey(key, result, error) {
    const waiters = waitersByKey.get(key) ?? []
    waitersByKey.delete(key)
    backoffByKey.delete(key)
    for (const w of waiters) {
      if (error) w.reject(error)
      else w.resolve(result)
    }
  }

  function enqueue(key) {
    return new Promise((resolve, reject) => {
      const existingWaiters = waitersByKey.get(key)
      if (existingWaiters) {
        // Dedupe: identical key already queued/in-flight — just add a waiter,
        // don't queue a second dispatch for the same key.
        existingWaiters.push({ resolve, reject })
        return
      }
      waitersByKey.set(key, [{ resolve, reject }])
      queue.push(key)
      ensureTimer()
    })
  }

  function size() {
    return queue.length
  }

  function destroy() {
    if (timerId !== null) {
      clock.clearTimeout(timerId)
      timerId = null
    }
  }

  return { enqueue, size, destroy }
}
