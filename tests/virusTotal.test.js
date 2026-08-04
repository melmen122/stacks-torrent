import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { hashFile, lookupHash, mapVerdict, validateApiKey } from '../electron/lib/virusTotal.js'

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-hash-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null }
  }
}

describe('hashFile', () => {
  it('matches the well-known SHA-256 test vector for "abc"', async () => {
    const filePath = path.join(root, 'abc.txt')
    await fs.writeFile(filePath, 'abc')
    const hash = await hashFile(filePath)
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches an independently-computed hash for arbitrary binary content', async () => {
    const { createHash } = await import('node:crypto')
    const content = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
    const filePath = path.join(root, 'binary.bin')
    await fs.writeFile(filePath, content)
    const expected = createHash('sha256').update(content).digest('hex')
    const hash = await hashFile(filePath)
    expect(hash).toBe(expected)
  })

  it('streams without buffering the whole file (works for content spanning many chunks)', async () => {
    const filePath = path.join(root, 'large.bin')
    // Larger than the default stream highWaterMark (64KB) so this exercises
    // multiple 'data' events, not a single-chunk read.
    const content = Buffer.alloc(300 * 1024, 7)
    await fs.writeFile(filePath, content)
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(content).digest('hex')
    const hash = await hashFile(filePath)
    expect(hash).toBe(expected)
  })

  it('rejects for a nonexistent file instead of hanging', async () => {
    await expect(hashFile(path.join(root, 'does-not-exist.bin'))).rejects.toThrow()
  })
})

describe('lookupHash', () => {
  it('200 with malicious detections -> status known with parsed stats', async () => {
    const fetchImpl = async () =>
      jsonResponse(200, {
        data: {
          attributes: { last_analysis_stats: { malicious: 3, suspicious: 1, harmless: 60, undetected: 10 } },
          links: { self: 'https://www.virustotal.com/api/v3/files/abc' }
        }
      })
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result).toEqual({
      status: 'known',
      malicious: 3,
      suspicious: 1,
      harmless: 60,
      undetected: 10,
      permalink: 'https://www.virustotal.com/api/v3/files/abc'
    })
  })

  it('404 -> status unknown (never treated as clean or bad)', async () => {
    const fetchImpl = async () => jsonResponse(404, {})
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result).toEqual({ status: 'unknown' })
  })

  it('401 -> status auth-error', async () => {
    const fetchImpl = async () => jsonResponse(401, {})
    const result = await lookupHash('abc', 'bad-key', { fetchImpl })
    expect(result).toEqual({ status: 'auth-error' })
  })

  it('403 -> status auth-error', async () => {
    const fetchImpl = async () => jsonResponse(403, {})
    const result = await lookupHash('abc', 'bad-key', { fetchImpl })
    expect(result).toEqual({ status: 'auth-error' })
  })

  it('429 -> status rate-limited with retryAfterMs parsed from the header', async () => {
    const fetchImpl = async () => jsonResponse(429, {}, { 'retry-after': '30' })
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result).toEqual({ status: 'rate-limited', retryAfterMs: 30000 })
  })

  it('429 without a retry-after header -> retryAfterMs null', async () => {
    const fetchImpl = async () => jsonResponse(429, {})
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result).toEqual({ status: 'rate-limited', retryAfterMs: null })
  })

  it('network failure (fetch throws) -> status error, never throws into the caller', async () => {
    const fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result.status).toBe('error')
    expect(result.message).toContain('ENOTFOUND')
  })

  it('a stalled connection is aborted after timeoutMs -> status error, never hangs forever', async () => {
    // Mimics real fetch's behavior when its AbortSignal fires: the request
    // never resolves on its own, only via the injected signal aborting.
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const started = Date.now()
    const result = await lookupHash('abc', 'fake-key', { fetchImpl, timeoutMs: 20 })
    expect(Date.now() - started).toBeLessThan(2000) // resolved via the short timeout, not left hanging
    expect(result.status).toBe('error')
    expect(result.message).toContain('timed out')
  })

  it('malformed JSON body -> status error, never throws', async () => {
    const fetchImpl = async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
      headers: { get: () => null }
    })
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result.status).toBe('error')
  })

  it('200 but missing last_analysis_stats -> status error (unexpected shape), never throws', async () => {
    const fetchImpl = async () => jsonResponse(200, { data: { attributes: {} } })
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result.status).toBe('error')
  })

  it('an unexpected non-2xx/404/401/403/429 status -> status error', async () => {
    const fetchImpl = async () => jsonResponse(500, {})
    const result = await lookupHash('abc', 'fake-key', { fetchImpl })
    expect(result.status).toBe('error')
    expect(result.message).toContain('500')
  })

  it('rejects locally (no network call) when the hash or key is missing', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return jsonResponse(200, {})
    }
    const r1 = await lookupHash('', 'key', { fetchImpl })
    const r2 = await lookupHash('abc', '', { fetchImpl })
    expect(r1.status).toBe('error')
    expect(r2.status).toBe('error')
    expect(called).toBe(false)
  })

  it('NEVER uploads file content — only ever performs a GET to the /files/<hash> lookup endpoint', async () => {
    let capturedUrl = null
    let capturedMethod = null
    const fetchImpl = async (url, opts) => {
      capturedUrl = url
      capturedMethod = opts?.method
      return jsonResponse(404, {})
    }
    await lookupHash('deadbeef', 'fake-key', { fetchImpl })
    expect(capturedMethod).toBe('GET')
    expect(capturedUrl).toContain('/files/deadbeef')
    expect(capturedUrl).not.toContain('/upload')
  })

  it('NEVER logs or exposes the API key: it only ever appears in the x-apikey request header, never in the URL or returned result', async () => {
    let capturedHeaders = null
    let capturedUrl = null
    const fetchImpl = async (url, opts) => {
      capturedUrl = url
      capturedHeaders = opts?.headers
      return jsonResponse(404, {})
    }
    const secretKey = 'super-secret-key-12345'
    const result = await lookupHash('deadbeef', secretKey, { fetchImpl })
    expect(capturedHeaders['x-apikey']).toBe(secretKey)
    expect(capturedUrl).not.toContain(secretKey)
    expect(JSON.stringify(result)).not.toContain(secretKey)
  })
})

describe('mapVerdict', () => {
  it('malicious >= 1 -> infected (even with some harmless/undetected too)', () => {
    expect(mapVerdict({ status: 'known', malicious: 1, suspicious: 0 })).toBe('infected')
    expect(mapVerdict({ status: 'known', malicious: 5, suspicious: 3 })).toBe('infected')
  })

  it('suspicious >= 2 && malicious === 0 -> suspicious', () => {
    expect(mapVerdict({ status: 'known', malicious: 0, suspicious: 2 })).toBe('suspicious')
    expect(mapVerdict({ status: 'known', malicious: 0, suspicious: 10 })).toBe('suspicious')
  })

  it('malicious === 0 && suspicious < 2 -> clean', () => {
    expect(mapVerdict({ status: 'known', malicious: 0, suspicious: 0 })).toBe('clean')
    expect(mapVerdict({ status: 'known', malicious: 0, suspicious: 1 })).toBe('clean')
  })

  it('unknown status -> unknown (never reads as clean)', () => {
    expect(mapVerdict({ status: 'unknown' })).toBe('unknown')
  })

  it('transient/non-final statuses conservatively map to unknown, never clean', () => {
    expect(mapVerdict({ status: 'rate-limited', retryAfterMs: 1000 })).toBe('unknown')
    expect(mapVerdict({ status: 'auth-error' })).toBe('unknown')
    expect(mapVerdict({ status: 'error', message: 'x' })).toBe('unknown')
    expect(mapVerdict(null)).toBe('unknown')
    expect(mapVerdict(undefined)).toBe('unknown')
  })
})

describe('validateApiKey', () => {
  it('a valid key (200 response) -> valid true', async () => {
    const fetchImpl = async () => jsonResponse(200, { data: { id: 'user1' } })
    const result = await validateApiKey('a-real-key', { fetchImpl })
    expect(result).toEqual({ valid: true, reason: null })
  })

  it('401/403 -> valid false, reason invalid-key', async () => {
    const fetchImpl401 = async () => jsonResponse(401, {})
    expect(await validateApiKey('bad-key', { fetchImpl: fetchImpl401 })).toEqual({
      valid: false,
      reason: 'invalid-key'
    })
    const fetchImpl403 = async () => jsonResponse(403, {})
    expect(await validateApiKey('bad-key', { fetchImpl: fetchImpl403 })).toEqual({
      valid: false,
      reason: 'invalid-key'
    })
  })

  it('network failure -> valid false, reason network-error, never throws', async () => {
    const fetchImpl = async () => {
      throw new Error('offline')
    }
    const result = await validateApiKey('a-key', { fetchImpl })
    expect(result).toEqual({ valid: false, reason: 'network-error' })
  })

  it('a stalled connection is aborted after timeoutMs -> valid false, never hangs forever', async () => {
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const started = Date.now()
    const result = await validateApiKey('a-key', { fetchImpl, timeoutMs: 20 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toEqual({ valid: false, reason: 'timeout' })
  })

  it('never calls a file-lookup or EICAR-style endpoint — only /users/<key>', async () => {
    let capturedUrl = null
    const fetchImpl = async (url) => {
      capturedUrl = url
      return jsonResponse(200, {})
    }
    await validateApiKey('my-key', { fetchImpl })
    expect(capturedUrl).toContain('/users/')
    expect(capturedUrl).not.toContain('/files/')
  })

  it('missing/empty key -> valid false without making any network call', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return jsonResponse(200, {})
    }
    expect(await validateApiKey('', { fetchImpl })).toEqual({ valid: false, reason: 'missing-key' })
    expect(await validateApiKey(null, { fetchImpl })).toEqual({ valid: false, reason: 'missing-key' })
    expect(called).toBe(false)
  })
})
