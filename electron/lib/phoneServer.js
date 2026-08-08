// electron/lib/phoneServer.js
//
// Embedded HTTP server exposing the audiobook library to a browser on the
// LAN/Tailscale (e.g. an iPhone/iPad) — serves the static mobile web client
// (built separately under `mobile/`), a small JSON API, and audio/cover
// streaming with HTTP range support. No dependency on `electron`'s `app`
// module: the caller (main.js) injects the library store, settings
// accessors, and a status-change callback, which keeps this importable and
// testable without a running Electron app (see `tests/phoneServer.test.js`).
//
// Auth model: a single shared PIN. On first enable, a random PIN + a random
// 32-byte secret are generated and persisted to settings (see main.js's
// DEFAULT_SETTINGS). A successful `POST /api/auth` sets a long-lived cookie
// containing `HMAC-SHA256(secret, pin)` (hex) — this makes sessions survive
// an app restart (same secret+pin -> same token) while being invalidated
// automatically whenever the PIN is regenerated (new secret -> new token).
// All PIN/token comparisons are constant-time (see `constantTimeEqual`).

import http from 'node:http'
import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createReadStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { parseRange } from './mediaRange.js'
import { mimeTypeFor } from './mimeTypes.js'
import { ALLOWED_AUDIO_EXTENSIONS } from './metadata.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// electron/lib/ -> repo/app root -> mobile/. Mirrors main.js's
// `path.join(__dirname, '../dist/index.html')` pattern one level deeper.
const MOBILE_DIR = path.resolve(__dirname, '../../mobile')

export const DEFAULT_PHONE_SERVER_PORT = 8787

const COOKIE_NAME = 'stacks_phone'
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 // 1 year

const AUTH_FAILURE_WINDOW_MS = 60000
const AUTH_MAX_FAILURES = 5

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Random 6-digit numeric PIN, zero-padded (e.g. "042319"). */
function generatePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

/**
 * Constant-time string comparison that never leaks length via an
 * early-return branch: both inputs are hashed to a fixed-length digest
 * first, so `crypto.timingSafeEqual` always compares equal-length buffers
 * regardless of the original strings' lengths.
 */
function constantTimeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const bufB = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(bufA, bufB)
}

function computeToken(secretHex, pin) {
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(pin).digest('hex')
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!key) continue
    // A malformed percent-escape (e.g. a bare "%") throws inside
    // decodeURIComponent — that must never turn an auth check into a 500;
    // just treat that one cookie value as absent.
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      // skip
    }
  }
  return out
}

/**
 * DNS-rebinding guard: a page on the open internet can point a hostname at
 * the phone server's LAN/Tailscale IP and then fetch it same-origin (no CORS
 * barrier), using the browser as a confused deputy to brute-force the PIN.
 * Only accept requests whose `Host` is an IP-literal, `localhost`, or a
 * Tailscale MagicDNS name (`*.ts.net`) — never an arbitrary attacker-chosen
 * hostname — and, when a port is present, that it matches the port this
 * server is actually listening on.
 */
function isValidHostHeader(hostHeader, expectedPort) {
  if (!hostHeader || typeof hostHeader !== 'string') return false

  let hostname = hostHeader
  let portPart = null

  if (hostHeader.startsWith('[')) {
    // IPv6 literal, e.g. "[::1]:8787".
    const closeIdx = hostHeader.indexOf(']')
    if (closeIdx === -1) return false
    hostname = hostHeader.slice(1, closeIdx)
    const rest = hostHeader.slice(closeIdx + 1)
    if (rest.startsWith(':')) portPart = rest.slice(1)
  } else {
    const idx = hostHeader.lastIndexOf(':')
    if (idx !== -1 && /^\d+$/.test(hostHeader.slice(idx + 1))) {
      hostname = hostHeader.slice(0, idx)
      portPart = hostHeader.slice(idx + 1)
    }
  }

  if (portPart !== null && Number(portPart) !== expectedPort) return false

  // A single trailing "." is a valid, semantically-identical FQDN form
  // (`localhost.`, `mydevice.tailnet.ts.net.`) that some clients/resolvers
  // append — strip exactly one before comparing so it isn't rejected. This
  // only normalizes the label boundary check below; it doesn't loosen which
  // hostnames are accepted (still only localhost/IP-literal/*.ts.net).
  const lower = hostname.toLowerCase().replace(/\.$/, '')
  if (lower === 'localhost') return true
  if (lower.endsWith('.ts.net')) return true
  if (net.isIP(lower)) return true
  return false
}

function buildSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
}

/** `100.64.0.0/10` — Tailscale's CGNAT range. */
function isTailscaleAddress(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function lanUrlsFor(port) {
  const interfaces = os.networkInterfaces()
  const urls = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue
      // Node <18 reports `family` as the string 'IPv4'; newer Node reports 4.
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      const label = isTailscaleAddress(entry.address) ? 'Tailscale' : 'Wi-Fi / LAN'
      urls.push({ label, url: `http://${entry.address}:${port}` })
    }
  }
  return urls
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload)
    })
  }
  res.end(payload)
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, maxBytes = 65536) {
  const raw = await readBody(req, maxBytes)
  if (!raw.length) return {}
  return JSON.parse(raw.toString('utf-8'))
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown'
}

/**
 * Wire-shape a `Book` (docs/models.md) for the phone client — strips every
 * absolute filesystem path (`files`, `coverPath`) down to non-identifying
 * fields. `name` is a basename only; the real path never leaves the server.
 */
function wireBook(book, genresById) {
  const genreName = book.genreId ? genresById.get(book.genreId) : null
  const files = Array.isArray(book.files) ? book.files : []
  // The data model only stores a single combined `durationSec` for the
  // whole book (see docs/models.md), not a per-file breakdown — so a
  // per-file duration is only known when the book has exactly one file.
  // Multi-file books report `null` for every file's durationSeconds.
  const singleFileDuration = files.length === 1 ? (book.durationSec ?? null) : null

  return {
    id: book.id,
    title: book.title,
    author: book.author,
    hasCover: !!book.coverPath,
    genres: genreName ? [genreName] : [],
    position: {
      fileIndex: book.position?.fileIndex ?? 0,
      seconds: book.position?.seconds ?? 0
    },
    files: files.map((filePath, index) => ({
      index,
      name: path.basename(filePath),
      durationSeconds: index === 0 ? singleFileDuration : null
    })),
    chapters: Array.isArray(book.chapters)
      ? book.chapters.map((ch) => ({
          title: ch.title,
          startSeconds: ch.startSec ?? 0,
          fileIndex: typeof ch.fileIndex === 'number' ? ch.fileIndex : null
        }))
      : []
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => object} deps.getLibrary - returns the library store (see
 *   `createLibraryStore` in library.js): `list()`, `findBook()`, `savePosition()`.
 * @param {() => object} deps.getSettings - returns the current settings
 *   object synchronously (main.js's `settingsCache`).
 * @param {(patch: object) => Promise<object>} deps.saveSettings - persists a
 *   settings patch and returns the merged settings (main.js's `saveSettings`).
 * @param {(status: object) => void} [deps.onStatusChange] - called whenever
 *   running/error state changes (e.g. to broadcast `phone:status-changed`).
 */
export function createPhoneServer({ getLibrary, getSettings, saveSettings, onStatusChange }) {
  let server = null
  // The actual OS-assigned port once listening (differs from the configured
  // port when that's `0`, i.e. "pick any free port" — used by tests).
  let actualPort = null
  let currentError = null
  // ip -> array of failure timestamps (ms), rolling 60s window.
  const authFailuresByIp = new Map()

  // `Number(port) || DEFAULT` would treat a configured port of `0`
  // (ephemeral — deliberately used by tests) as falsy and silently fall
  // back to the default, so this checks finiteness/range explicitly instead.
  function resolveConfiguredPort(settings) {
    const raw = Number(settings?.phoneServerPort)
    return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : DEFAULT_PHONE_SERVER_PORT
  }

  function notifyStatus() {
    if (typeof onStatusChange !== 'function') return
    try {
      onStatusChange(getStatus())
    } catch (err) {
      console.error('[phoneServer] onStatusChange callback threw:', err)
    }
  }

  function getStatus() {
    const settings = getSettings() ?? {}
    const running = !!server
    const port = running ? actualPort : resolveConfiguredPort(settings)
    return {
      enabled: !!settings.phoneServerEnabled,
      running,
      port,
      pin: settings.phoneServerPin ?? null,
      error: running ? null : currentError,
      urls: running ? lanUrlsFor(port) : []
    }
  }

  async function ensurePinAndSecret() {
    const settings = getSettings() ?? {}
    if (settings.phoneServerPin && settings.phoneServerSecret) return settings
    const pin = generatePin()
    const secret = crypto.randomBytes(32).toString('hex')
    return saveSettings({ phoneServerPin: pin, phoneServerSecret: secret })
  }

  // -- auth -------------------------------------------------------------

  function pruneFailures(ip) {
    const now = Date.now()
    const remaining = (authFailuresByIp.get(ip) ?? []).filter((t) => now - t < AUTH_FAILURE_WINDOW_MS)
    if (remaining.length) authFailuresByIp.set(ip, remaining)
    else authFailuresByIp.delete(ip)
    return remaining
  }

  function checkThrottle(ip) {
    const failures = pruneFailures(ip)
    if (failures.length >= AUTH_MAX_FAILURES) {
      const retryAfterMs = Math.max(0, AUTH_FAILURE_WINDOW_MS - (Date.now() - failures[0]))
      return { throttled: true, retryAfterMs }
    }
    return { throttled: false }
  }

  function recordFailure(ip) {
    const failures = pruneFailures(ip)
    failures.push(Date.now())
    authFailuresByIp.set(ip, failures)
  }

  function clearFailures(ip) {
    authFailuresByIp.delete(ip)
  }

  // `authFailuresByIp` was only ever pruned lazily, on the next request from
  // that same IP — an IP that fails once and never comes back (a scanner, a
  // spoofed/rotating source, etc.) stayed in the map forever. Sweep it on a
  // timer tied to the server's running lifecycle instead.
  let authSweepTimer = null

  function startAuthSweep() {
    if (authSweepTimer) return
    authSweepTimer = setInterval(() => {
      for (const ip of Array.from(authFailuresByIp.keys())) pruneFailures(ip)
    }, AUTH_FAILURE_WINDOW_MS)
    authSweepTimer.unref?.()
  }

  function stopAuthSweep() {
    if (authSweepTimer) clearInterval(authSweepTimer)
    authSweepTimer = null
  }

  function isAuthorized(req) {
    const settings = getSettings() ?? {}
    const { phoneServerPin: pin, phoneServerSecret: secret } = settings
    if (!pin || !secret) return false
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    if (!token) return false
    return constantTimeEqual(token, computeToken(secret, pin))
  }

  async function handleAuth(req, res) {
    const ip = clientIp(req)
    const throttle = checkThrottle(ip)
    if (throttle.throttled) {
      return sendJson(res, 429, { error: 'too_many_attempts', retryAfterMs: throttle.retryAfterMs })
    }

    // Cheap defence in depth: not exploitable today (SameSite=Lax cookie +
    // the DNS-rebinding Host guard already block a cross-site POST from
    // reaching here with credentials/a matching Host), but there's no
    // reason to accept a non-JSON body on the PIN endpoint. `/api/position`
    // deliberately does NOT get this check — it's hit by
    // `navigator.sendBeacon` from the mobile client, which may send
    // `text/plain`.
    const contentType = req.headers['content-type'] || ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return sendJson(res, 400, { error: 'invalid_body' })
    }

    let body
    try {
      body = await readJsonBody(req, 4096)
    } catch {
      return sendJson(res, 400, { error: 'invalid_body' })
    }

    const settings = getSettings() ?? {}
    const { phoneServerPin: pin, phoneServerSecret: secret } = settings
    const suppliedPin = typeof body?.pin === 'string' ? body.pin : ''

    if (!pin || !secret || !suppliedPin || !constantTimeEqual(suppliedPin, pin)) {
      recordFailure(ip)
      return sendJson(res, 401, { error: 'invalid_pin' })
    }

    clearFailures(ip)
    const token = computeToken(secret, pin)
    res.setHeader('Set-Cookie', buildSessionCookie(token))
    sendJson(res, 200, { ok: true })
  }

  function handleSession(req, res) {
    if (isAuthorized(req)) return sendJson(res, 200, { ok: true })
    sendJson(res, 401, { error: 'unauthorized' })
  }

  // -- data API -----------------------------------------------------------

  function genresById() {
    const { genres } = getLibrary().list()
    return new Map((genres ?? []).map((g) => [g.id, g.name]))
  }

  function handleLibraryList(req, res) {
    const { books } = getLibrary().list()
    const byId = genresById()
    sendJson(res, 200, { books: (books ?? []).map((b) => wireBook(b, byId)) })
  }

  function handleGetBook(req, res, bookId) {
    const book = getLibrary().findBook(bookId)
    if (!book) return sendJson(res, 404, { error: 'not_found' })
    sendJson(res, 200, wireBook(book, genresById()))
  }

  async function handlePosition(req, res) {
    let body
    try {
      body = await readJsonBody(req, 4096)
    } catch {
      return sendJson(res, 400, { error: 'invalid_body' })
    }

    const { bookId, fileIndex, seconds } = body ?? {}
    const validShape =
      typeof bookId === 'string' &&
      bookId.length > 0 &&
      Number.isInteger(fileIndex) &&
      fileIndex >= 0 &&
      typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds >= 0
    if (!validShape) return sendJson(res, 400, { error: 'invalid_body' })

    const library = getLibrary()
    const book = library.findBook(bookId)
    if (!book) return sendJson(res, 404, { error: 'not_found' })

    // `fileIndex` indexes straight into `book.files` on the desktop side
    // (`book.files[position.fileIndex]`) — an out-of-range value stored here
    // turns into an `undefined` file the next time the desktop reads it back.
    const fileCount = Array.isArray(book.files) ? book.files.length : 0
    if (fileIndex >= fileCount) return sendJson(res, 400, { error: 'invalid_body' })

    // `durationSec` (docs/models.md) is the whole book's combined duration,
    // not a per-file one (see `wireBook`'s comment) — so this is only a
    // coarse upper bound for multi-file books, but it's still enough to
    // reject/clamp wildly out-of-range values like `seconds: 1e12`.
    let clampedSeconds = seconds
    if (typeof book.durationSec === 'number' && Number.isFinite(book.durationSec) && book.durationSec > 0) {
      clampedSeconds = Math.min(seconds, book.durationSec)
    }

    await library.savePosition(bookId, fileIndex, clampedSeconds)
    sendJson(res, 200, { ok: true })
  }

  /**
   * Streams `filePath` to `res` via `stream.pipeline` instead of `.pipe()`.
   *
   * `.pipe()` only attaches an error handler to the *destination*; a source
   * error (e.g. the file is deleted between our `fs.stat` and the
   * `fs.ReadStream`'s internal `open()`) was an unhandled 'error' event on
   * the source, which is an uncaught exception that crashes the whole
   * Electron main process (B1). `.pipe()` also never destroys the source
   * when the destination closes early (a client abort), so its fd was never
   * released — `pipeline()` always destroys both ends, fixing the fd leak
   * (B2) too.
   *
   * Headers are only written once the fd is confirmed open, so a file
   * vanishing between the caller's `stat` and here surfaces as a clean 500
   * instead of a truncated 200/206.
   */
  async function serveFile(res, filePath, status, headers, streamOptions) {
    const readStream = createReadStream(filePath, streamOptions)

    try {
      await new Promise((resolve, reject) => {
        readStream.once('open', resolve)
        readStream.once('error', reject)
      })
    } catch (err) {
      console.error('[phoneServer] stream open error:', err?.code || 'unknown')
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      else res.destroy()
      return
    }

    if (!res.headersSent) res.writeHead(status, headers)

    try {
      await pipeline(readStream, res)
    } catch (err) {
      // A client abort mid-stream (ECONNRESET / ERR_STREAM_PREMATURE_CLOSE /
      // ABORT_ERR) is routine — iOS Safari does this constantly while
      // seeking/backgrounding — `pipeline()` still destroys the read stream
      // either way, which is what closes its fd. Anything else is logged by
      // code only, never a path.
      const code = err?.code || err?.message
      if (code !== 'ECONNRESET' && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ABORT_ERR') {
        console.error('[phoneServer] stream error:', code)
      }
    }
  }

  async function handleCover(req, res, bookId) {
    const book = getLibrary().findBook(bookId)
    if (!book || !book.coverPath) return sendJson(res, 404, { error: 'not_found' })

    const stat = await fs.stat(book.coverPath).catch(() => null)
    if (!stat || !stat.isFile()) return sendJson(res, 404, { error: 'not_found' })

    const ext = path.extname(book.coverPath).toLowerCase()
    const headers = {
      'Content-Type': mimeTypeFor(ext),
      'Content-Length': String(stat.size)
    }
    // Mirrors handleMedia's HEAD short-circuit: a HEAD response body is
    // always discarded, so answering from the already-stat'd headers alone
    // avoids opening the fd and reading the whole cover image off disk just
    // to throw it away.
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }
    await serveFile(res, book.coverPath, 200, headers)
  }

  async function handleMedia(req, res, bookId, fileIndexRaw, rangeHeader) {
    const fileIndex = Number(fileIndexRaw)
    if (!bookId || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return sendJson(res, 404, { error: 'not_found' })
    }

    const book = getLibrary().findBook(bookId)
    if (!book) return sendJson(res, 404, { error: 'not_found' })

    const filePath = book.files?.[fileIndex]
    if (!filePath) return sendJson(res, 404, { error: 'not_found' })

    // The client never supplies a filesystem path — only bookId + index —
    // but re-validate the server-resolved path against the audio allowlist
    // as defense in depth before ever streaming bytes off disk.
    const ext = path.extname(filePath).toLowerCase()
    if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
      return sendJson(res, 404, { error: 'not_found' })
    }

    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) return sendJson(res, 404, { error: 'not_found' })

    const mimeType = mimeTypeFor(ext)
    // A multi-range request ("bytes=0-10,20-30") isn't supported — the
    // regex in `parseRange` only ever looks at the first range and would
    // otherwise silently answer 206 with just that one, which is a
    // spec-violating response body for a client that asked for several
    // ranges. Fall back to a normal full-body 200 instead.
    const isMultiRange = typeof rangeHeader === 'string' && rangeHeader.split(',').length > 1
    const range = isMultiRange ? null : parseRange(rangeHeader, stat.size)

    if (range?.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      return res.end()
    }

    if (range) {
      const { start, end } = range
      const headers = {
        'Content-Type': mimeType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes'
      }
      // A HEAD request never reads the response body — Node's
      // `_hasBody === false` makes `res.write()` inside `pipeline()` a
      // silent no-op with no backpressure, so `serveFile()` would still
      // open the fd and read the *entire* range (up to the whole file) off
      // disk just to throw every byte away. Answer HEAD from the headers
      // alone; nothing downstream of this needs the body.
      if (req.method === 'HEAD') {
        res.writeHead(206, headers)
        return res.end()
      }
      return await serveFile(res, filePath, 206, headers, { start, end })
    }

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes'
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }
    await serveFile(res, filePath, 200, headers)
  }

  // -- static mobile client -------------------------------------------------

  async function handleStatic(req, res, pathname) {
    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const resolved = path.resolve(MOBILE_DIR, relPath)

    // Boundary check deliberately includes the path separator, matching
    // mediaGate.js's covers-dir check, so a sibling directory that merely
    // starts with "mobile" can't be mistaken for being inside it.
    const withinMobile = resolved === MOBILE_DIR || resolved.startsWith(MOBILE_DIR + path.sep)
    if (!withinMobile) return sendJson(res, 404, { error: 'not_found' })

    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isFile()) return sendJson(res, 404, { error: 'not_found' })

    const ext = path.extname(resolved).toLowerCase()
    const headers = {
      'Content-Type': STATIC_MIME_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(stat.size)
    }
    // Mirrors handleMedia's HEAD short-circuit: a HEAD response body is
    // always discarded, so answering from the already-stat'd headers alone
    // avoids opening the fd and reading the whole file off disk just to
    // throw it away.
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }
    await serveFile(res, resolved, 200, headers)
  }

  // -- router ---------------------------------------------------------------

  async function handleRequest(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')

    // DNS-rebinding guard — see `isValidHostHeader`'s comment. Applies to
    // every route, including the unauthenticated `/api/auth` (the whole
    // point is stopping a same-origin PIN brute force from a page the user
    // merely has open in a tab, before auth ever comes into it).
    const expectedPort = actualPort ?? resolveConfiguredPort(getSettings() ?? {})
    if (!isValidHostHeader(req.headers.host, expectedPort)) {
      return sendJson(res, 421, { error: 'invalid_host' })
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      return sendJson(res, 400, { error: 'invalid_url' })
    }
    // Node's `http.ServerResponse` already suppresses the response body for
    // a HEAD request (see `_hasBody` in Node's http internals) as long as
    // headers/status are still written normally — so routing a HEAD request
    // through the exact same handlers as its GET equivalent is enough to
    // get "GET minus the body" for free, instead of falling through to 404.
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')

    try {
      if (method === 'POST' && pathname === '/api/auth') return await handleAuth(req, res)
      if (method === 'GET' && pathname === '/api/session') return handleSession(req, res)

      const requiresAuth =
        pathname.startsWith('/api/') || pathname.startsWith('/cover/') || pathname.startsWith('/media/')
      if (requiresAuth && !isAuthorized(req)) {
        return sendJson(res, 401, { error: 'unauthorized' })
      }

      if (method === 'GET' && pathname === '/api/library') return handleLibraryList(req, res)

      if (method === 'GET' && pathname.startsWith('/api/books/')) {
        const bookId = pathname.slice('/api/books/'.length).split('/')[0]
        return handleGetBook(req, res, bookId)
      }

      if (method === 'POST' && pathname === '/api/position') return await handlePosition(req, res)

      if (method === 'GET' && pathname.startsWith('/cover/')) {
        const bookId = pathname.slice('/cover/'.length).split('/')[0]
        return await handleCover(req, res, bookId)
      }

      if (method === 'GET' && pathname.startsWith('/media/')) {
        const [bookId, fileIndexRaw] = pathname.slice('/media/'.length).split('/')
        const rangeHeader = req.headers.range ?? null
        return await handleMedia(req, res, bookId, fileIndexRaw, rangeHeader)
      }

      if (requiresAuth) return sendJson(res, 404, { error: 'not_found' })

      if (method === 'GET') return await handleStatic(req, res, pathname)

      sendJson(res, 404, { error: 'not_found' })
    } catch (err) {
      console.error('[phoneServer] request error:', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      else res.end()
    }
  }

  // -- lifecycle --------------------------------------------------------

  function performStart() {
    return ensurePinAndSecret().then(() => {
      const settings = getSettings() ?? {}
      const port = resolveConfiguredPort(settings)

      return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          handleRequest(req, res).catch((err) => {
            console.error('[phoneServer] unhandled request error:', err)
            // `res.writeHead`/`res.end` (inside `sendJson`) can themselves
            // throw on a torn-down response — an iOS client aborting
            // mid-response is routine here — and a `.catch` derivative only
            // rejects if ITS handler throws. An uncaught throw here would be
            // an orphaned rejection crashing the whole Electron main
            // process, the exact class of bug fixed elsewhere in this file
            // (see the `inFlightStart`/BLOCKING-1 comments above).
            try {
              if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
            } catch (writeErr) {
              console.error('[phoneServer] failed to send error response:', writeErr?.code || writeErr?.message)
            }
          })
        })

        const onListenError = (err) => {
          srv.removeListener('listening', onListening)
          currentError = err?.code === 'EADDRINUSE' ? 'port_in_use' : 'listen_error'
          console.error('[phoneServer] failed to start:', err?.code || err?.message)
          // A boot-time bind failure (e.g. `settingsCache.phoneServerEnabled`
          // is true so `start()` runs during app init, before any window
          // exists to receive the resolved status here) must still reach an
          // already-open renderer the same way every other status change
          // does, or the UI has no way to learn the bind failed.
          notifyStatus()
          resolve(getStatus())
        }

        const onListening = () => {
          srv.removeListener('error', onListenError)
          server = srv
          actualPort = srv.address()?.port ?? port
          currentError = null
          // Runtime (post-bind) errors are logged but don't crash the app.
          srv.on('error', (err) => {
            console.error('[phoneServer] server error:', err?.code || err?.message)
          })
          startAuthSweep()
          notifyStatus()
          resolve(getStatus())
        }

        srv.once('error', onListenError)
        srv.once('listening', onListening)
        srv.listen(port, '0.0.0.0')
      })
    })
  }

  function performStop() {
    return new Promise((resolve) => {
      stopAuthSweep()
      if (!server) {
        // `stop()` used to early-return here without touching
        // `currentError` — so e.g. a failed `EADDRINUSE` bind left "That
        // port is already in use" on screen even after the user disabled
        // the feature (S1). Always clear it and notify on this path too.
        currentError = null
        notifyStatus()
        resolve(getStatus())
        return
      }
      const srv = server
      server = null
      actualPort = null
      currentError = null
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections()
      srv.close(() => {
        notifyStatus()
        resolve(getStatus())
      })
    })
  }

  // Every public lifecycle call is serialized on this single chain so
  // start/stop/restart can never interleave. Before this, `server` was only
  // assigned once the async 'listening' callback fired, so `start()`'s
  // `if (server) return ...` guard couldn't see an in-flight start — racing
  // `Promise.all([s.start(), s.start()])` bound two separate listening
  // servers and only tracked one, permanently orphaning the other (S6).
  let opChain = Promise.resolve()
  let inFlightStart = null
  // Counts the number of stop()/restart() calls issued but not yet settled
  // — i.e. the window between the call being issued and its own queued
  // performStop() actually running. `server` alone isn't enough to gate the
  // fast path below: a stop() queued behind other work on opChain leaves
  // `server` truthy right up until performStop() executes, so `if (server)`
  // can't distinguish "genuinely running, safe to short-circuit" from
  // "running now, but a stop is already committed to tear it down before
  // this start() would ever reach the front of the chain" — the same class
  // of guard-reads-stale-state bug as S6 (see opChain's comment above).
  //
  // This MUST be a counter, not a boolean: with two stop-ish ops overlapping
  // (e.g. `stop(); start(); stop();` or `restart(); stop();`), each one
  // decrements unconditionally when its OWN performStop() settles — with a
  // boolean, the earlier op's clear fires while the later one is still
  // committed on opChain, so the fast path below would see `!stopPending`
  // and short-circuit with a stale "running" status for a server already
  // scheduled for teardown, reopening the exact window this was added to
  // close. A counter only reaches 0 once every outstanding stop-ish op has
  // actually settled.
  let stopPending = 0

  function start() {
    if (server && stopPending === 0) return Promise.resolve(getStatus())
    if (inFlightStart) return inFlightStart

    const p = opChain.then(() => {
      // A queued stop/start ahead of us may have already started the
      // server by the time this link of the chain actually runs.
      if (server) return getStatus()
      return performStart()
    })
    // Memoize `p` itself, not `p.finally()`'s return value — `.finally()`
    // always returns a NEW promise, so comparing that new promise back
    // against `inFlightStart` inside its own callback can never be `true`.
    // That previously meant the memo never released and `start()` short-
    // circuited on a stale cached promise forever, even long after the
    // server had since been stopped (and possibly started again) — see
    // BLOCKING-1 in the phoneServer.js review.
    inFlightStart = p
    // `.finally()`'s return value must never be discarded: it's a NEW
    // promise that rejects with `p`'s own reason (per spec, `finally`'s
    // callback doesn't change the outcome), and nothing else observes that
    // promise — `opChain` and the caller's `await` both attach to `p`
    // directly, not to this one. A dropped rejected promise is an
    // `unhandledRejection`, which is an uncaught exception with no handler
    // anywhere in this repo (see main.js) and crashes the whole Electron
    // main process, even when the caller correctly handles `p` itself
    // (BLOCKING-1 in the phoneServer.js review). `.catch(() => {})` on the
    // `.finally()` result absorbs that duplicate rejection without
    // affecting `p` or `inFlightStart`'s clearing logic.
    p.finally(() => {
      if (inFlightStart === p) inFlightStart = null
    }).catch(() => {})
    opChain = p.catch(() => {})
    return p
  }

  function stop() {
    // A start() may still be in flight (queued behind us on opChain, not
    // yet resolved) — its memoized promise reflects the pre-stop world and
    // must not be handed to a start() call that comes in after this stop()
    // was issued. Clearing the memo here forces any such start() to build a
    // fresh link on opChain, which correctly runs after this stop().
    inFlightStart = null
    stopPending += 1
    const p = opChain.then(() => performStop())
    // Decrement on both settle paths so a rejected performStop() (it
    // doesn't currently reject, but nothing here should rely on that)
    // can't leave this op's count stuck incremented and permanently
    // disable start()'s fast path. Mirrors the `p.then(clear, clear)`
    // shape suggested for the inFlightStart memo above; unlike that one,
    // neither branch here re-throws, so the derived promise never rejects
    // and there's nothing to additionally `.catch()`.
    p.then(
      () => { stopPending -= 1 },
      () => { stopPending -= 1 }
    )
    opChain = p.catch(() => {})
    return p
  }

  function restart() {
    inFlightStart = null
    stopPending += 1
    const p = opChain
      .then(() => performStop())
      .then(
        (status) => {
          stopPending -= 1
          return status
        },
        (err) => {
          stopPending -= 1
          throw err
        }
      )
      .then(() => performStart())
    opChain = p.catch(() => {})
    return p
  }

  return { start, stop, restart, getStatus }
}
