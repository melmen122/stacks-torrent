// electron/lib/virusTotalCache.js
//
// Pure JSON read/write for userData/vt-cache.json (atomic tmp+rename write,
// same pattern as torrentPersistence.js/library.js). No Electron/`app`
// dependency — the caller passes in the resolved file path, so this is
// importable/testable with a plain temp-file fixture.
//
// Entry shape (docs/PLAN4B.md): a plain object mapping
//   sha256 -> { verdict, malicious, suspicious, checkedAt }
// Cache hits are free/instant and are never re-looked-up until they go
// stale — see `isCacheEntryFresh`/`CACHE_TTL_MS`.

import path from 'node:path'
import { promises as fs } from 'node:fs'

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, per docs/PLAN4B.md

export async function loadVirusTotalCache(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return {}
  }
}

export async function saveVirusTotalCache(filePath, cache) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = path.join(dir, `.vt-cache.json.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmpPath, JSON.stringify(cache, null, 2), 'utf-8')
  await fs.rename(tmpPath, filePath)
}

/**
 * @param {{checkedAt?: number}|undefined|null} entry
 * @param {number} [now]
 * @returns {boolean} true if `entry` exists and is within the TTL window.
 */
export function isCacheEntryFresh(entry, now = Date.now()) {
  if (!entry || typeof entry.checkedAt !== 'number') return false
  return now - entry.checkedAt < CACHE_TTL_MS
}
