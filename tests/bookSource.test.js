import { describe, it, expect } from 'vitest'
import { buildTorrentSource, buildImportSource, MAX_SOURCE_SKIPPED_ENTRIES } from '../electron/lib/bookSource.js'

describe('buildTorrentSource', () => {
  it('builds the documented shape from a classifyTorrentFiles-style report', () => {
    const report = {
      verdict: 'clean',
      hasAudio: true,
      skipped: [{ name: 'cover.jpg', category: 'companion', reason: 'small image' }]
    }
    const source = buildTorrentSource('deadbeef', report, 12345)
    expect(source).toEqual({
      type: 'torrent',
      infoHash: 'deadbeef',
      safety: {
        verdict: 'clean',
        hasAudio: true,
        skippedCount: 1,
        skipped: [{ name: 'cover.jpg', category: 'companion', reason: 'small image' }]
      },
      importedAt: 12345
    })
  })

  it('defaults importedAt to roughly now when omitted', () => {
    const before = Date.now()
    const source = buildTorrentSource('hash', { verdict: 'clean', hasAudio: true, skipped: [] })
    const after = Date.now()
    expect(source.importedAt).toBeGreaterThanOrEqual(before)
    expect(source.importedAt).toBeLessThanOrEqual(after)
  })

  it('caps the persisted skipped list to MAX_SOURCE_SKIPPED_ENTRIES entries', () => {
    expect(MAX_SOURCE_SKIPPED_ENTRIES).toBe(50)
    const skipped = Array.from({ length: 500 }, (_, i) => ({
      name: `junk-${i}.exe`,
      category: 'executable',
      reason: 'blocked'
    }))
    const source = buildTorrentSource('hash', { verdict: 'danger', hasAudio: true, skipped })
    expect(source.safety.skipped).toHaveLength(50)
    expect(source.safety.skipped[0]).toEqual({ name: 'junk-0.exe', category: 'executable', reason: 'blocked' })
    expect(source.safety.skipped[49]).toEqual({ name: 'junk-49.exe', category: 'executable', reason: 'blocked' })
  })

  it('the full skippedCount is NOT capped, even though the detail list is', () => {
    const skipped = Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, category: 'other', reason: 'r' }))
    const source = buildTorrentSource('hash', { verdict: 'caution', hasAudio: true, skipped })
    expect(source.safety.skippedCount).toBe(500)
    expect(source.safety.skipped).toHaveLength(50)
  })

  it('a report with an empty/no skipped list produces an empty capped list and zero count', () => {
    const source = buildTorrentSource('hash', { verdict: 'clean', hasAudio: true, skipped: [] })
    expect(source.safety.skipped).toEqual([])
    expect(source.safety.skippedCount).toBe(0)
  })

  it('is defensive against a missing/malformed report (never throws)', () => {
    expect(() => buildTorrentSource('hash', null)).not.toThrow()
    const source = buildTorrentSource('hash', null)
    expect(source.safety).toEqual({ verdict: 'unknown', hasAudio: false, skippedCount: 0, skipped: [] })
  })
})

describe('buildImportSource', () => {
  it('produces the minimal { type: "import", importedAt } shape — no invented safety verdict', () => {
    const source = buildImportSource(999)
    expect(source).toEqual({ type: 'import', importedAt: 999 })
    expect(source.safety).toBeUndefined()
  })

  it('defaults importedAt to roughly now when omitted', () => {
    const before = Date.now()
    const source = buildImportSource()
    const after = Date.now()
    expect(source.importedAt).toBeGreaterThanOrEqual(before)
    expect(source.importedAt).toBeLessThanOrEqual(after)
  })

  it('is distinguishable from a torrent source purely by `type`', () => {
    const imported = buildImportSource(1)
    const torrent = buildTorrentSource('hash', { verdict: 'clean', hasAudio: true, skipped: [] }, 1)
    expect(imported.type).toBe('import')
    expect(torrent.type).toBe('torrent')
    expect(imported.type).not.toBe(torrent.type)
  })
})
