import { describe, it, expect } from 'vitest'
import { createScanQueue, DEFAULT_REQUEST_INTERVAL_MS, MAX_BACKOFF_MS } from '../electron/lib/scanQueue.js'

/**
 * A fully manual, synchronous "clock": `setTimeout`/`clearTimeout` just
 * record what was scheduled rather than actually waiting, and `advance(ms)`
 * fires everything whose deadline has passed (in deadline order), letting
 * tests deterministically drive time forward without any real waiting.
 */
function createManualClock(startAt = 0) {
  let now = startAt
  let nextId = 1
  const timers = new Map() // id -> { deadline, fn }

  return {
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.set(id, { deadline: now + Math.max(0, ms), fn })
        return id
      },
      clearTimeout: (id) => {
        timers.delete(id)
      }
    },
    now: () => now,
    /**
     * Advance time by `ms`, total. Correctly simulates time actually
     * *passing* rather than just jumping `now` once and draining whatever's
     * already due at that single instant: repeatedly finds the earliest
     * still-pending timer and, if its deadline falls within the requested
     * window, moves `now` forward to exactly that deadline and fires it —
     * so a fired timer that itself schedules a *further* timer (e.g. the
     * next step of an exponential backoff) is still correctly picked up by
     * a later iteration of this same call, with `now` accurately reflecting
     * the simulated elapsed time at each step.
     */
    async advance(ms) {
      const targetTime = now + ms
      while (true) {
        const entries = [...timers.entries()]
        if (!entries.length) {
          now = targetTime
          return
        }
        const [nextId, nextTimer] = entries.reduce((a, b) => (a[1].deadline <= b[1].deadline ? a : b))
        if (nextTimer.deadline > targetTime) {
          now = targetTime
          return
        }
        now = nextTimer.deadline
        timers.delete(nextId)
        await nextTimer.fn()
      }
    },
    pendingTimerCount: () => timers.size
  }
}

describe('createScanQueue', () => {
  it('dispatches a single enqueued key and resolves with the lookup result', async () => {
    const { clock, advance } = createManualClock()
    const calls = []
    const queue = createScanQueue({
      clock,
      performLookup: async (key) => {
        calls.push(key)
        return { status: 'known', malicious: 0 }
      }
    })

    const promise = queue.enqueue('hash-a')
    await advance(0)
    const result = await promise
    expect(result).toEqual({ status: 'known', malicious: 0 })
    expect(calls).toEqual(['hash-a'])
  })

  it('respects the rate limit: does not dispatch the second request before requestIntervalMs has passed', async () => {
    const { clock, advance } = createManualClock()
    const dispatchTimes = []
    const queue = createScanQueue({
      clock,
      requestIntervalMs: 1000,
      performLookup: async (key) => {
        dispatchTimes.push(clock.now())
        return { status: 'known', malicious: 0 }
      }
    })

    const p1 = queue.enqueue('a')
    const p2 = queue.enqueue('b')
    await advance(0)
    await p1
    // Second request must not have dispatched yet — less than the interval has passed.
    expect(dispatchTimes).toEqual([0])

    await advance(999)
    expect(dispatchTimes).toEqual([0]) // still not dispatched at 999ms

    await advance(1)
    await p2
    expect(dispatchTimes).toEqual([0, 1000])
  })

  it('dedupes: enqueuing the same key twice before it resolves only performs ONE lookup, and both callers get the result', async () => {
    const { clock, advance } = createManualClock()
    let callCount = 0
    const queue = createScanQueue({
      clock,
      performLookup: async (key) => {
        callCount += 1
        return { status: 'known', malicious: 0, tag: key }
      }
    })

    const p1 = queue.enqueue('same-hash')
    const p2 = queue.enqueue('same-hash')
    await advance(0)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(callCount).toBe(1)
    expect(r1).toEqual(r2)
    expect(queue.size()).toBe(0)
  })

  it('never drops a rate-limited item: it requeues and eventually resolves after backoff', async () => {
    const { clock, advance } = createManualClock()
    let attempt = 0
    const queue = createScanQueue({
      clock,
      requestIntervalMs: 100,
      performLookup: async () => {
        attempt += 1
        if (attempt === 1) return { status: 'rate-limited', retryAfterMs: 500 }
        return { status: 'known', malicious: 0 }
      }
    })

    const promise = queue.enqueue('hash-x')
    await advance(0) // first attempt -> rate-limited, requeues
    expect(attempt).toBe(1)

    await advance(499)
    expect(attempt).toBe(1) // backoff not elapsed yet

    await advance(1)
    const result = await promise
    expect(attempt).toBe(2)
    expect(result).toEqual({ status: 'known', malicious: 0 })
  })

  it('backs off exponentially on repeated rate-limiting, capped at MAX_BACKOFF_MS', async () => {
    const { clock, advance } = createManualClock()
    const attemptTimes = []
    let attempts = 0
    const queue = createScanQueue({
      clock,
      requestIntervalMs: 1000,
      performLookup: async () => {
        attempts += 1
        attemptTimes.push(clock.now())
        if (attempts <= 5) return { status: 'rate-limited', retryAfterMs: 0 }
        return { status: 'known', malicious: 0 }
      }
    })

    const promise = queue.enqueue('hash-y')
    // Advance in a big enough single jump so every backoff step (which
    // doubles each time, capped at MAX_BACKOFF_MS) has definitely elapsed.
    await advance(10 * MAX_BACKOFF_MS)
    const result = await promise
    expect(result).toEqual({ status: 'known', malicious: 0 })
    expect(attempts).toBe(6)

    // Each gap between attempts should be non-decreasing (exponential
    // growth) up to the cap.
    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i])
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(Math.min(gaps[i - 1], MAX_BACKOFF_MS))
      expect(gaps[i]).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    }
  })

  it('a thrown/rejected lookup rejects the waiter but does not stop the queue processing the next item', async () => {
    const { clock, advance } = createManualClock()
    const queue = createScanQueue({
      clock,
      requestIntervalMs: 10,
      performLookup: async (key) => {
        if (key === 'bad') throw new Error('boom')
        return { status: 'known', malicious: 0 }
      }
    })

    const badPromise = queue.enqueue('bad')
    const goodPromise = queue.enqueue('good')

    await advance(0)
    await expect(badPromise).rejects.toThrow('boom')

    await advance(10)
    await expect(goodPromise).resolves.toEqual({ status: 'known', malicious: 0 })
  })

  it('uses DEFAULT_REQUEST_INTERVAL_MS (derived from 4 requests/minute) when no override is given', async () => {
    const { clock, advance } = createManualClock()
    const dispatchTimes = []
    const queue = createScanQueue({
      clock,
      performLookup: async () => {
        dispatchTimes.push(clock.now())
        return { status: 'known', malicious: 0 }
      }
    })
    const p1 = queue.enqueue('a')
    const p2 = queue.enqueue('b')
    await advance(0)
    await p1
    await advance(DEFAULT_REQUEST_INTERVAL_MS)
    await p2
    expect(dispatchTimes[1] - dispatchTimes[0]).toBe(DEFAULT_REQUEST_INTERVAL_MS)
    expect(DEFAULT_REQUEST_INTERVAL_MS).toBe(15000) // 60000ms / 4 per minute
  })

  it('destroy() clears any pending timer', async () => {
    const { clock } = createManualClock()
    const queue = createScanQueue({ clock, performLookup: async () => ({ status: 'known', malicious: 0 }) })
    queue.enqueue('a').catch(() => {})
    queue.destroy()
    // No assertion beyond "doesn't throw" — this is testing that destroy is
    // safe to call and doesn't leave a dangling real timer in production use.
  })
})
