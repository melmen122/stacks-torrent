import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import {
  loadVirusTotalCache,
  saveVirusTotalCache,
  isCacheEntryFresh,
  CACHE_TTL_MS
} from '../electron/lib/virusTotalCache.js'

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-cache-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('loadVirusTotalCache / saveVirusTotalCache', () => {
  it('returns an empty object when the file does not exist', async () => {
    const result = await loadVirusTotalCache(path.join(root, 'vt-cache.json'))
    expect(result).toEqual({})
  })

  it('round-trips a cache object byte-for-byte through save then load', async () => {
    const filePath = path.join(root, 'vt-cache.json')
    const cache = {
      aaaa: { verdict: 'clean', malicious: 0, suspicious: 0, checkedAt: 111 },
      bbbb: { verdict: 'infected', malicious: 5, suspicious: 1, checkedAt: 222 }
    }
    await saveVirusTotalCache(filePath, cache)
    const loaded = await loadVirusTotalCache(filePath)
    expect(loaded).toEqual(cache)
  })

  it('writes atomically (tmp file renamed into place, no leftover tmp files)', async () => {
    const filePath = path.join(root, 'vt-cache.json')
    await saveVirusTotalCache(filePath, { hash1: { verdict: 'clean', malicious: 0, suspicious: 0, checkedAt: 1 } })
    const entries = await fs.readdir(root)
    expect(entries).toEqual(['vt-cache.json'])
  })

  it('treats a malformed (non-object) cache file as empty rather than throwing', async () => {
    const filePath = path.join(root, 'vt-cache.json')
    await fs.writeFile(filePath, JSON.stringify([1, 2, 3]))
    const result = await loadVirusTotalCache(filePath)
    expect(result).toEqual({})
  })

  it('creates the parent directory if it does not exist yet', async () => {
    const filePath = path.join(root, 'nested', 'dir', 'vt-cache.json')
    await saveVirusTotalCache(filePath, { h: { verdict: 'clean', malicious: 0, suspicious: 0, checkedAt: 1 } })
    const loaded = await loadVirusTotalCache(filePath)
    expect(loaded.h.verdict).toBe('clean')
  })
})

describe('isCacheEntryFresh', () => {
  it('is fresh when checkedAt is within the TTL window', () => {
    const now = 1_000_000_000
    const entry = { checkedAt: now - 1000 }
    expect(isCacheEntryFresh(entry, now)).toBe(true)
  })

  it('is stale once the TTL has fully elapsed', () => {
    const now = 1_000_000_000
    const entry = { checkedAt: now - CACHE_TTL_MS }
    expect(isCacheEntryFresh(entry, now)).toBe(false)
  })

  it('is stale just past the TTL boundary', () => {
    const now = 1_000_000_000
    const entry = { checkedAt: now - CACHE_TTL_MS - 1 }
    expect(isCacheEntryFresh(entry, now)).toBe(false)
  })

  it('is fresh just inside the TTL boundary', () => {
    const now = 1_000_000_000
    const entry = { checkedAt: now - CACHE_TTL_MS + 1 }
    expect(isCacheEntryFresh(entry, now)).toBe(true)
  })

  it('is not fresh for a missing/null/malformed entry', () => {
    expect(isCacheEntryFresh(null)).toBe(false)
    expect(isCacheEntryFresh(undefined)).toBe(false)
    expect(isCacheEntryFresh({})).toBe(false)
    expect(isCacheEntryFresh({ checkedAt: 'not-a-number' })).toBe(false)
  })

  it('CACHE_TTL_MS is exactly 30 days', () => {
    expect(CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
