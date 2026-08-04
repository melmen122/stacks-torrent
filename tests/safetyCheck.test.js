import { describe, it, expect } from 'vitest'
import { classifyTorrentFiles } from '../electron/lib/safetyCheck.js'

describe('classifyTorrentFiles', () => {
  it('audio-only files -> clean, hasAudio true, nothing skipped', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 100 },
      { name: 'Book/02.m4b', length: 200 }
    ])
    expect(result.verdict).toBe('clean')
    expect(result.hasAudio).toBe(true)
    expect(result.audio).toHaveLength(2)
    expect(result.skipped).toEqual([])
    expect(result.counts).toEqual({ audio: 2, companion: 0, archive: 0, executable: 0, disguised: 0, other: 0 })
  })

  it('a bundled plain .exe alongside audio -> danger, exe skipped as executable', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 100 },
      { name: 'Book/setup.exe', length: 5000 }
    ])
    expect(result.verdict).toBe('danger')
    expect(result.hasAudio).toBe(true)
    expect(result.audio).toEqual([{ name: 'Book/01.mp3', length: 100 }])
    expect(result.skipped).toEqual([
      { name: 'Book/setup.exe', category: 'executable', reason: expect.stringContaining('.exe') }
    ])
    expect(result.counts.executable).toBe(1)
  })

  it('"book.mp3.exe" (disguised executable) -> danger, category disguised, reason mentions both extensions', () => {
    const result = classifyTorrentFiles([{ name: 'book.mp3.exe', length: 5000 }])
    expect(result.verdict).toBe('danger')
    expect(result.hasAudio).toBe(false)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].category).toBe('disguised')
    expect(result.skipped[0].reason).toContain('.mp3')
    expect(result.skipped[0].reason).toContain('.exe')
    expect(result.counts.disguised).toBe(1)
    expect(result.counts.executable).toBe(0)
  })

  it('"cover.jpg.scr" is also detected as disguised', () => {
    const result = classifyTorrentFiles([{ name: 'cover.jpg.scr', length: 100 }])
    expect(result.skipped[0].category).toBe('disguised')
    expect(result.skipped[0].reason).toContain('.jpg')
    expect(result.skipped[0].reason).toContain('.scr')
  })

  it('mixed audio + cover.jpg + release.nfo -> clean, companions skipped silently (no effect on verdict)', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 100 },
      { name: 'Book/cover.jpg', length: 50 },
      { name: 'Book/release.nfo', length: 10 }
    ])
    expect(result.verdict).toBe('clean')
    expect(result.hasAudio).toBe(true)
    expect(result.audio).toHaveLength(1)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.map((s) => s.category)).toEqual(['companion', 'companion'])
    expect(result.counts.companion).toBe(2)
  })

  it('an archive present alongside audio -> caution', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 100 },
      { name: 'Book/bonus.zip', length: 900 }
    ])
    expect(result.verdict).toBe('caution')
    expect(result.hasAudio).toBe(true)
    expect(result.skipped).toEqual([
      { name: 'Book/bonus.zip', category: 'archive', reason: expect.stringContaining('.zip') }
    ])
    expect(result.counts.archive).toBe(1)
  })

  it('no audio at all (only exe + pdf) -> hasAudio false, danger verdict (executable wins over caution)', () => {
    const result = classifyTorrentFiles([
      { name: 'setup.exe', length: 5000 },
      { name: 'manual.pdf', length: 100 }
    ])
    expect(result.hasAudio).toBe(false)
    expect(result.audio).toEqual([])
    expect(result.verdict).toBe('danger')
    expect(result.skipped).toHaveLength(2)
  })

  it('no audio, no danger (only pdf + unknown) -> hasAudio false, caution verdict', () => {
    const result = classifyTorrentFiles([
      { name: 'manual.pdf', length: 100 },
      { name: 'readme', length: 10 }
    ])
    expect(result.hasAudio).toBe(false)
    expect(result.verdict).toBe('caution')
  })

  it('is case-insensitive for both audio and executable extensions', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.MP3', length: 100 },
      { name: 'Book/virus.ExE', length: 5000 }
    ])
    expect(result.hasAudio).toBe(true)
    expect(result.audio).toEqual([{ name: 'Book/01.MP3', length: 100 }])
    expect(result.skipped[0].category).toBe('executable')
    expect(result.verdict).toBe('danger')
  })

  it('a file with no extension at all -> category other, caution-level', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 100 },
      { name: 'Book/README', length: 10 }
    ])
    expect(result.verdict).toBe('caution')
    expect(result.skipped).toEqual([
      { name: 'Book/README', category: 'other', reason: expect.stringContaining('no extension') }
    ])
    expect(result.counts.other).toBe(1)
  })

  it('a file with an unrecognized extension -> category other, reason mentions it', () => {
    const result = classifyTorrentFiles([{ name: 'Book/data.xyz', length: 10 }])
    expect(result.skipped[0].category).toBe('other')
    expect(result.skipped[0].reason).toContain('.xyz')
  })

  it('counts across every category are correct for a large mixed manifest', () => {
    const result = classifyTorrentFiles([
      { name: 'Book/01.mp3', length: 1 },
      { name: 'Book/02.m4b', length: 1 },
      { name: 'Book/cover.jpg', length: 1 },
      { name: 'Book/release.nfo', length: 1 },
      { name: 'Book/bonus.zip', length: 1 },
      { name: 'Book/extra.rar', length: 1 },
      { name: 'Book/setup.exe', length: 1 },
      { name: 'Book/track.mp3.exe', length: 1 },
      { name: 'Book/unknown.xyz', length: 1 },
      { name: 'Book/noext', length: 1 }
    ])
    expect(result.counts).toEqual({
      audio: 2,
      companion: 2,
      archive: 2,
      executable: 1,
      disguised: 1,
      other: 2
    })
    expect(result.verdict).toBe('danger')
    expect(result.hasAudio).toBe(true)
    expect(result.audio).toHaveLength(2)
    expect(result.skipped).toHaveLength(8)
  })

  it('handles an empty file list gracefully', () => {
    const result = classifyTorrentFiles([])
    expect(result.verdict).toBe('clean')
    expect(result.hasAudio).toBe(false)
    expect(result.audio).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('handles a non-array input gracefully', () => {
    const result = classifyTorrentFiles(undefined)
    expect(result.hasAudio).toBe(false)
    expect(result.audio).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('no-audio torrent containing ONLY companion files -> hasAudio false, caution verdict', () => {
    const result = classifyTorrentFiles([
      { name: 'cover.jpg', length: 100 },
      { name: 'release.nfo', length: 10 },
      { name: 'playlist.m3u', length: 5 }
    ])
    expect(result.hasAudio).toBe(false)
    expect(result.audio).toEqual([])
    expect(result.verdict).toBe('caution')
    expect(result.skipped).toHaveLength(3)
    expect(result.skipped.every((s) => s.category === 'companion')).toBe(true)
  })

  describe('adversarial filenames -> verdict must not be under-warned', () => {
    it('a trailing space after the extension is still recognized as executable/danger', () => {
      const result = classifyTorrentFiles([{ name: 'evil.exe ', length: 100 }])
      expect(result.skipped[0].category).toBe('executable')
      expect(result.verdict).toBe('danger')
    })

    it('a trailing dot after the extension is still recognized as executable/danger', () => {
      const result = classifyTorrentFiles([{ name: 'evil.exe.', length: 100 }])
      expect(result.skipped[0].category).toBe('executable')
      expect(result.verdict).toBe('danger')
    })

    it('a run of trailing dots and spaces is still recognized as executable/danger', () => {
      const result = classifyTorrentFiles([{ name: 'evil.exe.  .', length: 100 }])
      expect(result.skipped[0].category).toBe('executable')
      expect(result.verdict).toBe('danger')
    })

    it('a Unicode RTL-override character used to visually disguise the extension does not fool classification', () => {
      // The literal/real extension is ".exe" (what the OS uses to decide
      // execution behavior); the RLO character only changes how the name
      // *displays* in a bidi-aware file browser, not the underlying bytes.
      const name = 'audiobook' + String.fromCharCode(0x202e) + 'gpj.exe'
      const result = classifyTorrentFiles([{ name, length: 100 }])
      expect(result.skipped[0].category).toBe('executable')
      expect(result.verdict).toBe('danger')
    })

    it('mixed-case extensions with trailing whitespace still classify correctly', () => {
      const result = classifyTorrentFiles([{ name: 'EVIL.ExE ', length: 100 }])
      expect(result.skipped[0].category).toBe('executable')
      expect(result.verdict).toBe('danger')
    })

    it('a normal filename with an internal (non-trailing) space is unaffected', () => {
      const result = classifyTorrentFiles([{ name: 'Chapter One.mp3', length: 100 }])
      expect(result.audio).toEqual([{ name: 'Chapter One.mp3', length: 100 }])
      expect(result.verdict).toBe('clean')
    })

    it('newly widened executable extensions are recognized (macOS/script/shortcut forms)', () => {
      for (const ext of ['.command', '.workflow', '.py', '.desktop', '.url', '.msix']) {
        const result = classifyTorrentFiles([{ name: `bad${ext}`, length: 10 }])
        expect(result.skipped[0].category, `expected ${ext} to be executable`).toBe('executable')
        expect(result.verdict, `expected ${ext} to be danger`).toBe('danger')
      }
    })

    it('newly widened archive extensions are recognized', () => {
      for (const ext of ['.tgz', '.zst', '.arj', '.001']) {
        const result = classifyTorrentFiles([{ name: `bundle${ext}`, length: 10 }])
        expect(result.skipped[0].category, `expected ${ext} to be archive`).toBe('archive')
        expect(result.verdict, `expected ${ext} to be caution`).toBe('caution')
      }
    })
  })

  describe('cover image selection (docs/PLAN4B.md)', () => {
    it('a small jpg alongside audio appears in BOTH covers and skipped (still companion)', () => {
      const result = classifyTorrentFiles([
        { name: 'Book/01.mp3', length: 100 },
        { name: 'Book/cover.jpg', length: 1024 }
      ])
      expect(result.covers).toEqual([{ name: 'Book/cover.jpg', length: 1024 }])
      expect(result.skipped).toEqual([
        { name: 'Book/cover.jpg', category: 'companion', reason: expect.stringContaining('.jpg') }
      ])
      expect(result.counts.companion).toBe(1)
      expect(result.verdict).toBe('clean')
    })

    it('an oversized image (> 5 MB cap) is skipped as companion but NOT selectable as a cover', () => {
      const result = classifyTorrentFiles([
        { name: 'Book/01.mp3', length: 100 },
        { name: 'Book/huge-cover.png', length: 6 * 1024 * 1024 }
      ])
      expect(result.covers).toEqual([])
      expect(result.skipped[0].category).toBe('companion')
    })

    it('a companion image extension outside the cover-selectable set (.gif/.bmp) is not selectable', () => {
      const result = classifyTorrentFiles([
        { name: 'Book/01.mp3', length: 100 },
        { name: 'Book/anim.gif', length: 100 },
        { name: 'Book/bitmap.bmp', length: 100 }
      ])
      expect(result.covers).toEqual([])
      expect(result.skipped).toHaveLength(2)
    })

    it('multiple valid cover candidates all appear in covers', () => {
      const result = classifyTorrentFiles([
        { name: 'Book/01.mp3', length: 100 },
        { name: 'Book/cover.jpg', length: 100 },
        { name: 'Book/folder.png', length: 200 },
        { name: 'Book/back.webp', length: 300 }
      ])
      expect(result.covers).toHaveLength(3)
      expect(result.covers.map((c) => c.name).sort()).toEqual(['Book/back.webp', 'Book/cover.jpg', 'Book/folder.png'])
    })

    it('no images at all -> covers is an empty array', () => {
      const result = classifyTorrentFiles([{ name: 'Book/01.mp3', length: 100 }])
      expect(result.covers).toEqual([])
    })

    it('exactly at the 5 MB cap is still selectable (inclusive boundary)', () => {
      const result = classifyTorrentFiles([{ name: 'cover.jpg', length: 5 * 1024 * 1024 }])
      expect(result.covers).toEqual([{ name: 'cover.jpg', length: 5 * 1024 * 1024 }])
    })
  })
})
