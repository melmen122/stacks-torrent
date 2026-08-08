import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import nodeHttp from 'node:http'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { createPhoneServer } from '../electron/lib/phoneServer.js'

const PIN = '654321'

// Registry of every `fs.createReadStream()` call made through
// `phoneServer.js` while `node:fs` is mocked below — used by the B2
// fd-release test to assert every stream it opened actually ended up
// `destroyed`, instead of relying on `fs.rm()` succeeding (which it does on
// Windows regardless, since libuv opens files with FILE_SHARE_DELETE).
const { readStreamRegistry } = vi.hoisted(() => ({ readStreamRegistry: [] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createReadStream: (...args) => {
      const stream = actual.createReadStream(...args)
      readStreamRegistry.push(stream)
      return stream
    }
  }
})

/** Resolves `true` if `port` accepts a real TCP connection, `false` otherwise. */
function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

// Mirrors phoneServer.js's own `MOBILE_DIR` computation (electron/lib/ ->
// repo root -> mobile/), one level shallower since this file lives directly
// under tests/.
const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile')

/**
 * A raw `http.request` helper for cases `fetch()` can't express — notably
 * setting a `Host` header, which the Fetch spec forbids overriding.
 */
function rawRequest(base, { method = 'GET', path: reqPath, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base)
    const req = nodeHttp.request(
      { hostname: url.hostname, port: url.port, path: reqPath, method, headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function createMockLibrary(books = [], genres = []) {
  const savePosition = vi.fn(async (bookId, fileIndex, seconds) => {
    const book = books.find((b) => b.id === bookId)
    if (!book) throw new Error(`Book not found: ${bookId}`)
    book.position = { fileIndex, seconds }
    return { ok: true }
  })
  return {
    books,
    list: () => ({ books, genres }),
    findBook: (id) => books.find((b) => b.id === id) ?? null,
    savePosition
  }
}

function createMockSettingsStore(initial) {
  let settings = { ...initial }
  return {
    get: () => settings,
    save: async (patch) => {
      settings = { ...settings, ...patch }
      return settings
    }
  }
}

async function loginCookie(base) {
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN })
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toMatch(/^stacks_phone=/)
  return setCookie.split(';')[0]
}

describe('phoneServer', () => {
  let tempDir
  let audioPath
  let library
  let settingsStore
  let server
  let base

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-server-'))
    audioPath = path.join(tempDir, 'chapter.mp3')
    await fs.writeFile(audioPath, Buffer.from('0123456789abcdefghij'))

    library = createMockLibrary([
      {
        id: 'b1',
        title: 'Test Book',
        author: 'Test Author',
        files: [audioPath],
        coverPath: null,
        durationSec: 20,
        genreId: null,
        position: { fileIndex: 0, seconds: 5 },
        chapters: null
      }
    ])

    settingsStore = createMockSettingsStore({
      phoneServerEnabled: true,
      phoneServerPort: 0,
      phoneServerPin: PIN,
      phoneServerSecret: crypto.randomBytes(32).toString('hex')
    })

    server = createPhoneServer({
      getLibrary: () => library,
      getSettings: settingsStore.get,
      saveSettings: settingsStore.save,
      onStatusChange: () => {}
    })

    const status = await server.start()
    expect(status.running).toBe(true)
    base = `http://127.0.0.1:${status.port}`
  })

  afterEach(async () => {
    await server.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('auth', () => {
    it('rejects a protected route with no cookie', async () => {
      const res = await fetch(`${base}/api/library`)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    })

    it('rejects a protected route with an invalid/garbage cookie', async () => {
      const res = await fetch(`${base}/api/library`, {
        headers: { Cookie: 'stacks_phone=not-a-real-token' }
      })
      expect(res.status).toBe(401)
    })

    it('accepts access after a correct PIN', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/library`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)

      const sessionRes = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })
      expect(sessionRes.status).toBe(200)
      expect(await sessionRes.json()).toEqual({ ok: true })
    })

    it('rejects a wrong PIN, then throttles to 429 after 5 failures', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '000000' })
        })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'invalid_pin' })
      }

      const throttled = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '000000' })
      })
      expect(throttled.status).toBe(429)
      const body = await throttled.json()
      expect(body.error).toBe('too_many_attempts')
      expect(typeof body.retryAfterMs).toBe('number')

      // A correct PIN is also throttled while over the limit.
      const correctButThrottled = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN })
      })
      expect(correctButThrottled.status).toBe(429)
    })
  })

  describe('/api/library', () => {
    it('never includes absolute filesystem paths', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/library`, { headers: { Cookie: cookie } })
      const raw = await res.text()
      expect(raw).not.toContain(audioPath)
      expect(raw).not.toContain(tempDir)

      const body = JSON.parse(raw)
      expect(body.books).toHaveLength(1)
      expect(body.books[0].files[0]).toEqual({
        index: 0,
        name: 'chapter.mp3',
        durationSeconds: 20
      })
    })
  })

  describe('POST /api/position', () => {
    it('validates and forwards args to savePosition', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bookId: 'b1', fileIndex: 0, seconds: 12.5 })
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(library.savePosition).toHaveBeenCalledWith('b1', 0, 12.5)
    })

    it('rejects a fileIndex at or beyond book.files.length (S5)', async () => {
      const cookie = await loginCookie(base)
      // The mock book (`b1`) only has one file (index 0), so both the
      // boundary value and something wildly out of range must be rejected.
      for (const fileIndex of [1, 999999]) {
        const res = await fetch(`${base}/api/position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ bookId: 'b1', fileIndex, seconds: 1 })
        })
        expect(res.status).toBe(400)
      }
      expect(library.savePosition).not.toHaveBeenCalled()
    })

    it('clamps an out-of-range seconds value against the book duration instead of storing it verbatim', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bookId: 'b1', fileIndex: 0, seconds: 1e12 })
      })
      expect(res.status).toBe(200)
      // Mock book's durationSec is 20.
      expect(library.savePosition).toHaveBeenCalledWith('b1', 0, 20)
    })

    it('rejects a malformed body without calling savePosition', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bookId: 'b1', fileIndex: 'not-a-number', seconds: 1 })
      })
      expect(res.status).toBe(400)
      expect(library.savePosition).not.toHaveBeenCalled()
    })

    it('404s for an unknown book', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bookId: 'nope', fileIndex: 0, seconds: 0 })
      })
      expect(res.status).toBe(404)
      expect(library.savePosition).not.toHaveBeenCalled()
    })
  })

  describe('/media/:bookId/:fileIndex', () => {
    it('serves a full request with 200 + Accept-Ranges', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/media/b1/0`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-type')).toBe('audio/mpeg')
      const body = await res.text()
      expect(body).toBe('0123456789abcdefghij')
    })

    it('serves a range request with 206 + correct Content-Range', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/media/b1/0`, {
        headers: { Cookie: cookie, Range: 'bytes=0-3' }
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-3/20')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      const body = await res.text()
      expect(body).toBe('0123')
    })

    it('404s for an unknown bookId', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/media/nope/0`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(404)
    })

    it('404s for an out-of-range file index', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/media/b1/9`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(404)
    })

    it('requires auth', async () => {
      const res = await fetch(`${base}/media/b1/0`)
      expect(res.status).toBe(401)
    })

    it('answers 200 with the full body for a multi-range request instead of 206 with only the first range', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/media/b1/0`, {
        headers: { Cookie: cookie, Range: 'bytes=0-3,5-8' }
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('0123456789abcdefghij')
    })

    describe('416 responses', () => {
      it('416s a range request against a zero-length file', async () => {
        const emptyPath = path.join(tempDir, 'empty.mp3')
        await fs.writeFile(emptyPath, Buffer.alloc(0))
        library.books.push({
          id: 'empty',
          title: 'Empty',
          author: 'A',
          files: [emptyPath],
          coverPath: null,
          durationSec: 0,
          genreId: null,
          position: { fileIndex: 0, seconds: 0 },
          chapters: null
        })

        const cookie = await loginCookie(base)
        const res = await fetch(`${base}/media/empty/0`, {
          headers: { Cookie: cookie, Range: 'bytes=0-10' }
        })
        expect(res.status).toBe(416)
        expect(res.headers.get('content-range')).toBe('bytes */0')
      })

      it('416s when the requested range start is at/beyond the file size', async () => {
        const cookie = await loginCookie(base)
        const res = await fetch(`${base}/media/b1/0`, {
          headers: { Cookie: cookie, Range: 'bytes=1000-2000' }
        })
        expect(res.status).toBe(416)
        expect(res.headers.get('content-range')).toBe('bytes */20')
      })
    })

    describe('streaming safety (B1/B2)', () => {
      it('a file vanishing between stat() and open() yields a 5xx, not an uncaught exception', async () => {
        const uncaughtHandler = vi.fn()
        process.on('uncaughtException', uncaughtHandler)

        const originalStat = fs.stat.bind(fs)
        const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target, ...rest) => {
          const result = await originalStat(target, ...rest)
          if (target === audioPath) {
            // Simulate the TOCTOU race: the file is removed right after
            // `fs.stat` succeeds but before `createReadStream` opens it —
            // e.g. the user deleted the book's files while it was streaming.
            await fs.rm(target).catch(() => {})
          }
          return result
        })

        try {
          const cookie = await loginCookie(base)
          const res = await fetch(`${base}/media/b1/0`, { headers: { Cookie: cookie } })
          expect(res.status).toBeGreaterThanOrEqual(500)
          expect(res.status).toBeLessThan(600)
        } finally {
          statSpy.mockRestore()
          process.off('uncaughtException', uncaughtHandler)
        }

        expect(uncaughtHandler).not.toHaveBeenCalled()
      })

      it('destroys the read stream on a client abort, releasing the file handle (B2)', async () => {
        const bigPath = path.join(tempDir, 'big.mp3')
        await fs.writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024, 1))
        library.books.push({
          id: 'big',
          title: 'Big',
          author: 'A',
          files: [bigPath],
          coverPath: null,
          durationSec: 999,
          genreId: null,
          position: { fileIndex: 0, seconds: 0 },
          chapters: null
        })

        const cookie = await loginCookie(base)

        // `fs.rm()` succeeding is NOT proof the fd was released: libuv opens
        // files with FILE_SHARE_DELETE on Windows, so unlink (and even a
        // parent rmdir) succeeds identically whether or not a read stream on
        // it is still open — that made the old version of this test pass
        // against both the fixed `pipeline()` code AND the old broken
        // `.pipe()` code it was meant to catch. Track every stream
        // `serveFile()` actually opens (via the `node:fs` mock above) and
        // assert on the stream's own `destroyed` state instead, which is
        // exactly what `pipeline()` vs `.pipe()` differ on.
        readStreamRegistry.length = 0

        // Several aborted requests in a row, mirroring iOS Safari aborting
        // range requests constantly while seeking/backgrounding. `fetch()`
        // may resolve to a `Response` before the abort lands (headers can
        // arrive before we cancel) and only reject once the body is read —
        // either way is fine here, the point is exercising the server-side
        // abort path, not the exact client-side rejection shape.
        for (let i = 0; i < 5; i++) {
          const controller = new AbortController()
          const pending = fetch(`${base}/media/big/0`, { headers: { Cookie: cookie }, signal: controller.signal })
            .then((res) => res.arrayBuffer())
            .catch(() => {})
          setTimeout(() => controller.abort(), 5)
          await pending
        }

        // Give pipeline()'s async cleanup a tick to actually destroy the
        // source streams and close their fds.
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(readStreamRegistry.length).toBeGreaterThan(0)
        for (const stream of readStreamRegistry) {
          expect(stream.destroyed).toBe(true)
          expect(stream.closed).toBe(true)
        }

        // Belt-and-suspenders: still confirm the file is actually deletable
        // (would also pass under the old broken code on Windows, per the
        // comment above, but is a real symptom on other platforms/setups).
        await expect(fs.rm(bigPath)).resolves.toBeUndefined()
      })
    })
  })

  describe('/cover/:bookId', () => {
    it('requires auth', async () => {
      const res = await fetch(`${base}/cover/b1`)
      expect(res.status).toBe(401)
    })

    it('404s when the book has no coverPath', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/cover/b1`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(404)
    })

    it('404s for an unknown bookId', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/cover/nope`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(404)
    })

    it('serves the cover image with the right content-type', async () => {
      const coverPath = path.join(tempDir, 'cover.jpg')
      await fs.writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      library.books[0].coverPath = coverPath

      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/cover/b1`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      const body = Buffer.from(await res.arrayBuffer())
      expect(body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    })
  })

  describe('static file serving', () => {
    it('rejects path traversal escaping the mobile/ root (encoded slashes bypass URL dot-segment collapsing)', async () => {
      const res = await fetch(`${base}/..%2f..%2fpackage.json`)
      expect(res.status).toBe(404)
    })

    it('rejects path traversal via encoded backslashes (..%5c)', async () => {
      const res = await fetch(`${base}/..%5c..%5cpackage.json`)
      expect(res.status).toBe(404)
    })

    it('rejects an absolute Windows drive-letter path escaping the mobile/ root', async () => {
      const res = await fetch(`${base}/D:/Windows/win.ini`)
      expect(res.status).toBe(404)
    })

    it('rejects a sibling directory whose name merely starts with "mobile" (case-insensitively)', async () => {
      // The boundary check must not mistake "../MOBILE-evil/secret.txt" for
      // being inside mobile/ itself just because it starts with the same
      // prefix (case-insensitively, as Windows' filesystem is).
      const siblingDir = path.resolve(MOBILE_DIR, '..', 'MOBILE-evil')
      await fs.mkdir(siblingDir, { recursive: true })
      await fs.writeFile(path.join(siblingDir, 'secret.txt'), 'nope')
      try {
        const res = await fetch(`${base}/../MOBILE-evil/secret.txt`)
        expect(res.status).toBe(404)
      } finally {
        await fs.rm(siblingDir, { recursive: true, force: true })
      }
    })

    it('404s (not 500) on a missing static file', async () => {
      const res = await fetch(`${base}/this-file-does-not-exist.js`)
      expect(res.status).toBe(404)
    })

    it('serves mobile/index.html at GET / with no auth required', async () => {
      const res = await fetch(`${base}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
    })
  })

  describe('HEAD requests', () => {
    it('HEAD / behaves like GET / but with no body', async () => {
      const res = await fetch(`${base}/`, { method: 'HEAD' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
      expect(await res.text()).toBe('')
    })

    it('HEAD on a protected route still requires auth', async () => {
      const res = await fetch(`${base}/api/library`, { method: 'HEAD' })
      expect(res.status).toBe(401)
    })

    it('HEAD /api/library succeeds with auth and no body', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/library`, { method: 'HEAD', headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    })
  })

  describe('response hygiene', () => {
    it('sets Cache-Control: no-store on /api/* responses', async () => {
      const cookie = await loginCookie(base)
      const res = await fetch(`${base}/api/library`, { headers: { Cookie: cookie } })
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('treats a malformed percent-escaped cookie as absent, not a 500', async () => {
      const res = await fetch(`${base}/api/library`, { headers: { Cookie: 'stacks_phone=%' } })
      expect(res.status).toBe(401)
    })
  })

  describe('cookie attributes', () => {
    it('sets the session cookie with HttpOnly, SameSite=Lax, Path=/, and a 1-year Max-Age', async () => {
      const res = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN })
      })
      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toMatch(/^stacks_phone=[0-9a-f]+;/)
      expect(setCookie).toMatch(/HttpOnly/)
      expect(setCookie).toMatch(/SameSite=Lax/)
      expect(setCookie).toMatch(/Path=\//)
      expect(setCookie).toMatch(/Max-Age=31536000/)
    })
  })

  describe('auth throttle window', () => {
    it('clears failures after a successful auth', async () => {
      for (let i = 0; i < 4; i++) {
        await fetch(`${base}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '000000' })
        })
      }
      const ok = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN })
      })
      expect(ok.status).toBe(200)

      // A fresh run of wrong-PIN attempts should each be plain 401s, not
      // immediately 429 — proving the earlier failures were cleared.
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${base}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '000000' })
        })
        expect(res.status).toBe(401)
      }
    })

    it('prunes failures older than the 60s window, un-throttling', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${base}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '000000' })
          })
          expect(res.status).toBe(401)
        }

        const throttled = await fetch(`${base}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '000000' })
        })
        expect(throttled.status).toBe(429)

        vi.setSystemTime(Date.now() + 60_001)

        const afterWindow = await fetch(`${base}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '000000' })
        })
        expect(afterWindow.status).toBe(401)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Host header validation (DNS-rebinding guard)', () => {
    it('rejects a request whose Host is a rebindable hostname, not an IP/localhost/*.ts.net', async () => {
      const res = await rawRequest(base, { path: '/api/library', headers: { Host: 'evil.example.com' } })
      expect(res.status).toBe(421)
    })

    it('allows a Tailscale MagicDNS-style Host header through to normal routing', async () => {
      const port = new URL(base).port
      const res = await rawRequest(base, {
        path: '/api/session',
        headers: { Host: `mydevice.tailnet-name.ts.net:${port}` }
      })
      // Reaches the normal auth check (no cookie sent) rather than being
      // rejected for the Host header itself.
      expect(res.status).toBe(401)
    })

    it('allows an IP-literal Host header (the normal case)', async () => {
      const res = await rawRequest(base, { path: '/api/session' })
      expect(res.status).toBe(401)
    })
  })
})

describe('phoneServer lifecycle', () => {
  let tempDir
  let audioPath
  let library

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-server-lifecycle-'))
    audioPath = path.join(tempDir, 'chapter.mp3')
    await fs.writeFile(audioPath, Buffer.from('0123456789abcdefghij'))
    library = createMockLibrary([
      {
        id: 'b1',
        title: 'Test Book',
        author: 'Test Author',
        files: [audioPath],
        coverPath: null,
        durationSec: 20,
        genreId: null,
        position: { fileIndex: 0, seconds: 5 },
        chapters: null
      }
    ])
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  function makeServer(settingsOverrides = {}) {
    const settingsStore = createMockSettingsStore({
      phoneServerEnabled: true,
      phoneServerPort: 0,
      phoneServerPin: PIN,
      phoneServerSecret: crypto.randomBytes(32).toString('hex'),
      ...settingsOverrides
    })
    return createPhoneServer({
      getLibrary: () => library,
      getSettings: settingsStore.get,
      saveSettings: settingsStore.save,
      onStatusChange: () => {}
    })
  }

  it('concurrent start() calls bind exactly one listening server (S6)', async () => {
    const server = makeServer()
    const createServerSpy = vi.spyOn(nodeHttp, 'createServer')

    try {
      const [s1, s2, s3] = await Promise.all([server.start(), server.start(), server.start()])
      expect(createServerSpy).toHaveBeenCalledTimes(1)
      expect(s1.running).toBe(true)
      expect(s2.running).toBe(true)
      expect(s3.running).toBe(true)
      // All three resolve to the same bound port — if a second server had
      // been bound (the pre-fix race), a concurrent start() would have
      // picked its own independent ephemeral port.
      expect(s2.port).toBe(s1.port)
      expect(s3.port).toBe(s1.port)
    } finally {
      createServerSpy.mockRestore()
      await server.stop()
    }
  })

  it('start()/stop()/restart() calls made concurrently still serialize to a consistent final state', async () => {
    const server = makeServer()
    // `results.at(-1)` is the SECOND start() call's own resolved value —
    // `Promise.all` preserves input order regardless of settle order — but
    // BLOCKING-1's stale-memo bug made `start()` return the memoized FIRST
    // start()'s (pre-stop) promise instead. `.running` reads `true` either
    // way, which is exactly why the old version of this assertion couldn't
    // catch it: it must be cross-checked against the server's live state and
    // a real socket, not just the resolved value's own `.running` flag.
    const results = await Promise.all([server.start(), server.stop(), server.start()])
    expect(results.at(-1).running).toBe(true)

    const live = server.getStatus()
    expect(live.running).toBe(true)
    expect(results.at(-1).port).toBe(live.port)
    await expect(canConnect(live.port)).resolves.toBe(true)

    await server.stop()
  })

  it('start() -> stop() -> start() sequentially rebinds a genuinely listening server (BLOCKING-1 regression)', async () => {
    // No test in the suite previously exercised a plain sequential
    // stop-then-restart — the concurrent S6/S6-followup tests above cover
    // the interleaved case, but BLOCKING-1 (an `inFlightStart` memo that
    // could never be cleared) broke even this straight-line sequence: the
    // second `start()` short-circuited on the first call's cached promise
    // and returned a stale `{ running: true }` for a server that was
    // actually stopped, with `getStatus()` reporting `running: false` and
    // the reported port refusing new TCP connections.
    const server = makeServer()

    const first = await server.start()
    expect(first.running).toBe(true)
    await expect(canConnect(first.port)).resolves.toBe(true)

    const stopped = await server.stop()
    expect(stopped.running).toBe(false)
    expect(server.getStatus().running).toBe(false)
    await expect(canConnect(first.port)).resolves.toBe(false)

    const second = await server.start()
    expect(second.running).toBe(true)
    expect(server.getStatus().running).toBe(true)
    expect(server.getStatus().port).toBe(second.port)
    await expect(canConnect(second.port)).resolves.toBe(true)

    await server.stop()
  })

  it('a subsequent restart() succeeds once a conflicting port frees up, even though the server was never running (S1)', async () => {
    const occupied = makeServer()
    const occupiedStatus = await occupied.start()
    expect(occupiedStatus.running).toBe(true)

    const conflicted = makeServer({ phoneServerPort: occupiedStatus.port })
    const failedStatus = await conflicted.start()
    expect(failedStatus.running).toBe(false)
    expect(failedStatus.error).toBe('port_in_use')

    await occupied.stop()

    // Mirrors what `phone:setPort` must now do: call restart() gated on
    // "enabled", not "running" — `running` is false here, which is exactly
    // the state that used to make changing the port a dead end (S1).
    const recovered = await conflicted.restart()
    expect(recovered.running).toBe(true)
    expect(recovered.error).toBeNull()

    await conflicted.stop()
  })

  it('stop() clears a stale currentError even when the server was never running', async () => {
    const occupied = makeServer()
    const occupiedStatus = await occupied.start()

    const conflicted = makeServer({ phoneServerPort: occupiedStatus.port })
    const failedStatus = await conflicted.start()
    expect(failedStatus.error).toBe('port_in_use')

    const statusAfterStop = await conflicted.stop()
    expect(statusAfterStop.error).toBeNull()

    await occupied.stop()
  })

  it('start() retried after a failed bind (no intervening stop/restart) picks up the freed port (BLOCKING-1 memo regression)', async () => {
    // The concurrent/sequential-with-stop tests above both pass through a
    // stop(), which clears `inFlightStart` itself (see stop()'s own
    // comment) and masks a broken memo. The one path the memo fix actually
    // guards is a start() retried after a *failed* bind with no stop() or
    // restart() in between — nothing else in this file exercises that.
    const occupied = makeServer()
    const occupiedStatus = await occupied.start()
    expect(occupiedStatus.running).toBe(true)

    const conflicted = makeServer({ phoneServerPort: occupiedStatus.port })
    const failedStatus = await conflicted.start()
    expect(failedStatus.running).toBe(false)
    expect(failedStatus.error).toBe('port_in_use')

    // Frees the port `conflicted` wants, without ever calling stop()/
    // restart() on `conflicted` itself.
    await occupied.stop()

    const again = await conflicted.start()
    expect(again.running).toBe(true)
    expect(conflicted.getStatus().running).toBe(true)
    expect(conflicted.getStatus().port).toBe(again.port)
    await expect(canConnect(again.port)).resolves.toBe(true)

    await conflicted.stop()
  })

  it('a rejected start() does not crash via an orphaned unhandledRejection, and a later start() still runs (BLOCKING-1 regression)', async () => {
    // `ensurePinAndSecret()` only calls `saveSettings()` when no pin/secret
    // is already persisted, so this server (unlike `makeServer()`'s
    // default) must be built without either, to force that write to
    // actually happen and actually be able to fail.
    const settingsStore = createMockSettingsStore({ phoneServerEnabled: true, phoneServerPort: 0 })
    let shouldFail = true
    const saveSettings = vi.fn(async (patch) => {
      if (shouldFail) throw new Error('keytar/disk write failed')
      return settingsStore.save(patch)
    })
    const server = createPhoneServer({
      getLibrary: () => library,
      getSettings: settingsStore.get,
      saveSettings,
      onStatusChange: () => {}
    })

    const unhandled = []
    const onUnhandledRejection = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await expect(server.start()).rejects.toThrow('keytar/disk write failed')

      // Give any orphaned rejected promise (the discarded `.finally()`
      // return value, pre-fix) several microtask/macrotask turns to
      // surface as `unhandledRejection` before asserting its absence.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(unhandled).toHaveLength(0)

      // The underlying write now succeeds — a caller that correctly
      // handled the rejected start() (as this test just did) must still
      // be able to retry.
      shouldFail = false
      const retried = await server.start()
      expect(retried.running).toBe(true)
      expect(server.getStatus().running).toBe(true)
      await expect(canConnect(retried.port)).resolves.toBe(true)

      await server.stop()
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }
  })

  it('stop() then start() issued in the same tick end up running, matching the last-issued intent (S6-followup)', async () => {
    // Reproduces the reviewer's harness scenario D: a caller (e.g.
    // `phone:setEnabled` toggled off then back on in the same event-loop
    // turn) issues `stop()` immediately followed by `start()`, with no
    // `await` — and therefore no microtask drain — between them. `start()`'s
    // `if (server) return ...` fast path reads `server` synchronously at
    // call time, before the already-queued `stop()` has actually run, so it
    // can't see that a stop is already committed ahead of it on `opChain`.
    const server = makeServer()
    await server.start()

    const stopPromise = server.stop()
    const startPromise = server.start()
    const [, startResult] = await Promise.all([stopPromise, startPromise])

    expect(startResult.running).toBe(true)
    const live = server.getStatus()
    expect(live.running).toBe(true)
    expect(startResult.port).toBe(live.port)
    await expect(canConnect(live.port)).resolves.toBe(true)

    await server.stop()
  })

  it('a start() racing two overlapping stop-ish ops never returns a stale "running" for a server about to be torn down (stopPending counter regression)', async () => {
    // `stopPending` gates start()'s synchronous fast path against a
    // stop/restart that's already committed on `opChain` but hasn't run
    // yet. As a boolean, it breaks with TWO overlapping stop-ish ops: the
    // first one's clear fires (as soon as ITS OWN performStop() settles)
    // even though the second is still committed and hasn't run — so a
    // start() call landing in that window sees `server && !stopPending`
    // and incorrectly takes the fast path, synchronously reporting
    // `running: true` for a server one microtask away from being torn
    // down again by the still-queued second stop.
    //
    // That window only opens once `server` is genuinely truthy again
    // between the two stops — i.e. once the first stop's *middle* start()
    // has actually finished rebinding — and closes the instant the second,
    // already-queued stop's `performStop()` actually runs (which nulls
    // `server` synchronously, before any of ITS OWN async close work). A
    // caller that reacts to the middle start() resolving (e.g. a status
    // listener, or another IPC call landing at just the wrong moment) is
    // exactly early enough to observe it, since that's a direct `.then()`
    // on the middle start()'s promise — one microtask hop closer than the
    // still-queued second stop, which is chained two hops deeper (through
    // an intermediate `.catch()` on `opChain`).
    const server = makeServer()
    await server.start()

    const stop1 = server.stop()
    const startMiddle = server.start()
    const stop2 = server.stop()

    // Fires exactly when `startMiddle` resolves — landing, by construction
    // above, before `stop2`'s own queued `performStop()` has run.
    const raced = startMiddle.then(() => server.start())

    await Promise.all([stop1, startMiddle, stop2, raced])

    const racedStatus = await raced
    // Whatever `raced` resolves to, it must never be a lie: a reported
    // `running: true` has to be genuinely, currently true — checked via a
    // side channel (`getStatus()`/a real socket) it doesn't control —
    // never a synchronously-fast-pathed snapshot of a server that's
    // already been (or is about to be) torn down by the still-queued
    // second stop.
    if (racedStatus.running) {
      expect(server.getStatus().running).toBe(true)
      await expect(canConnect(racedStatus.port)).resolves.toBe(true)
    } else {
      expect(server.getStatus().running).toBe(false)
    }

    await server.stop()
  })
})
