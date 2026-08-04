// electron/lib/virusTotal.js
//
// Pure-ish VirusTotal integration primitives (docs/PLAN4B.md): streamed
// SHA-256 hashing, a single hash lookup against the VT v3 API, API-key
// validation, and verdict mapping. No electron `app` dependency — `fetch`
// is injectable (`fetchImpl`) so nothing here ever needs to hit the real
// network in tests, and file paths are passed in explicitly.
//
// This is Layer 2 on top of docs/PLAN4.md's pre-download manifest check:
// VirusTotal identifies files by content hash, so a lookup can only ever
// happen AFTER a file's bytes exist locally (post-download) — it can never
// run before downloading. Only hashes ever leave this machine; file content
// is NEVER uploaded (VT's upload-for-analysis endpoint is intentionally
// unused). The API key is never logged and never included in any returned
// error/reason string.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const VT_API_BASE = 'https://www.virustotal.com/api/v3'

// The scan queue (electron/lib/scanQueue.js) dispatches ONE request at a
// time; without an explicit timeout, a single stalled connection would
// block ALL scanning until the underlying HTTP client's own default (often
// several minutes) — an explicit abort keeps a hung request from stalling
// the whole pipeline. Exported so tests/callers can override it (e.g. to a
// few ms for a fast timeout test).
export const DEFAULT_FETCH_TIMEOUT_MS = 30000

/**
 * Streamed SHA-256 of a file, without ever buffering the whole file in
 * memory — safe for multi-GB audiobook files. Uses `node:crypto`'s
 * `createHash` fed incrementally from a `fs.createReadStream`.
 *
 * Chosen over a worker_thread for this version: hashing happens per-chunk
 * as each streamed chunk arrives (an async, event-driven read, handled by
 * libuv's thread pool for the actual disk I/O), and `hash.update()` for a
 * single ~64KB chunk (the default stream `highWaterMark`) takes on the
 * order of microseconds even on modest hardware — the event loop gets a
 * chance to run between every chunk. This is the standard Node.js pattern
 * for streaming hashes and should not cause noticeable stalls even for
 * multi-GB files scanned sequentially in the background. If profiling ever
 * shows otherwise in practice, this is the function to move into a
 * worker_thread — nothing else in the VirusTotal pipeline depends on it
 * running on the main thread.
 *
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex SHA-256
 */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', (err) => reject(err))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * One VirusTotal hash lookup. Never throws — every failure mode (network,
 * auth, rate limit, malformed response) resolves to a tagged result object
 * instead, so callers never need a try/catch around this.
 *
 * @param {string} sha256
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults
 *   to the global `fetch`.
 * @param {number} [opts.timeoutMs] - abort the request after this long;
 *   defaults to `DEFAULT_FETCH_TIMEOUT_MS`.
 * @returns {Promise<
 *   | { status: 'known', malicious: number, suspicious: number, harmless: number, undetected: number, permalink: string|null }
 *   | { status: 'unknown' }
 *   | { status: 'auth-error' }
 *   | { status: 'rate-limited', retryAfterMs: number|null }
 *   | { status: 'error', message: string }
 * >}
 */
export async function lookupHash(sha256, apiKey, { fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? fetch
  if (!sha256 || typeof sha256 !== 'string') {
    return { status: 'error', message: 'Missing or invalid hash' }
  }
  if (!apiKey || typeof apiKey !== 'string') {
    return { status: 'error', message: 'Missing API key' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await doFetch(`${VT_API_BASE}/files/${sha256}`, {
      method: 'GET',
      headers: { 'x-apikey': apiKey },
      signal: controller.signal
    })
  } catch (err) {
    const timedOut = err?.name === 'AbortError'
    return { status: 'error', message: timedOut ? 'Request timed out' : `Network error: ${err?.message || 'request failed'}` }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 404) return { status: 'unknown' }
  if (response.status === 401 || response.status === 403) return { status: 'auth-error' }
  if (response.status === 429) {
    const retryAfterHeader = response.headers?.get?.('retry-after')
    const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN
    const retryAfterMs = Number.isFinite(parsed) ? Math.max(0, parsed * 1000) : null
    return { status: 'rate-limited', retryAfterMs }
  }

  if (!response.ok) {
    return { status: 'error', message: `Unexpected VirusTotal response: HTTP ${response.status}` }
  }

  let body
  try {
    body = await response.json()
  } catch {
    return { status: 'error', message: 'Malformed JSON response from VirusTotal' }
  }

  const stats = body?.data?.attributes?.last_analysis_stats
  if (!stats || typeof stats !== 'object') {
    return { status: 'error', message: 'Unexpected VirusTotal response shape' }
  }

  const permalink = typeof body?.data?.links?.self === 'string' ? body.data.links.self : null

  return {
    status: 'known',
    malicious: toNonNegativeInt(stats.malicious),
    suspicious: toNonNegativeInt(stats.suspicious),
    harmless: toNonNegativeInt(stats.harmless),
    undetected: toNonNegativeInt(stats.undetected),
    permalink
  }
}

function toNonNegativeInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * Maps a `lookupHash` result to a final verdict — ONLY meaningful for
 * `'known'`/`'unknown'` statuses (the two the plan defines a mapping for).
 * Transient/non-final statuses (`'rate-limited'`, `'auth-error'`,
 * `'error'`) are the caller's responsibility to retry or surface as a scan
 * error, not a verdict — passing one here returns `'unknown'` as a safe,
 * conservative default (never silently reported as "clean").
 *
 * @param {object} lookupResult - a `lookupHash()` result.
 * @returns {'infected'|'suspicious'|'clean'|'unknown'}
 */
export function mapVerdict(lookupResult) {
  if (lookupResult?.status === 'known') {
    if (lookupResult.malicious >= 1) return 'infected'
    if (lookupResult.suspicious >= 2 && lookupResult.malicious === 0) return 'suspicious'
    if (lookupResult.malicious === 0 && lookupResult.suspicious < 2) return 'clean'
  }
  return 'unknown'
}

/**
 * Validates an API key with ONE cheap real call — GET /users/<key> (VT
 * allows fetching your own account info using the key itself as the user
 * ID), NOT a file lookup and NEVER an EICAR-style fetch. Never returns or
 * logs the key itself in the result.
 *
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs] - abort the request after this long;
 *   defaults to `DEFAULT_FETCH_TIMEOUT_MS`.
 * @returns {Promise<{ valid: boolean, reason: string|null }>}
 */
export async function validateApiKey(apiKey, { fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? fetch
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, reason: 'missing-key' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await doFetch(`${VT_API_BASE}/users/${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: { 'x-apikey': apiKey },
      signal: controller.signal
    })
  } catch (err) {
    return { valid: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network-error' }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    return { valid: false, reason: 'invalid-key' }
  }
  if (response.ok) {
    return { valid: true, reason: null }
  }
  return { valid: false, reason: `unexpected-status-${response.status}` }
}
