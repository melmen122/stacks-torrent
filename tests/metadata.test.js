// Covers the pure helpers only. scanBookFiles depends on music-metadata's
// parseFile and needs real audio fixtures, so it is deliberately not tested
// here (see the QA report).
import { describe, it, expect } from 'vitest'
import {
  ALLOWED_AUDIO_EXTENSIONS,
  isAudioFile,
  isExternalCoverName,
  naturalCompare,
  sortAudioFilesNaturally
} from '../electron/lib/metadata.js'

describe('isAudioFile', () => {
  it('accepts every allowlisted extension', () => {
    for (const ext of ALLOWED_AUDIO_EXTENSIONS) {
      expect(isAudioFile(`/x/book${ext}`)).toBe(true)
    }
  })

  it('accepts uppercase and mixed-case extensions', () => {
    expect(isAudioFile('/x/BOOK.MP3')).toBe(true)
    expect(isAudioFile('/x/book.M4b')).toBe(true)
  })

  it('rejects non-audio and trick extensions', () => {
    expect(isAudioFile('/x/book.txt')).toBe(false)
    expect(isAudioFile('/x/book.mp3.txt')).toBe(false)
    expect(isAudioFile('/x/book')).toBe(false)
    expect(isAudioFile('/x/.mp3/file')).toBe(false)
    expect(isAudioFile('/x/book.mp4')).toBe(false)
  })
})

describe('isExternalCoverName', () => {
  it('recognizes common cover file names case-insensitively', () => {
    expect(isExternalCoverName('/dir/cover.jpg')).toBe(true)
    expect(isExternalCoverName('/dir/Folder.PNG')).toBe(true)
    expect(isExternalCoverName('/dir/cover.jpeg')).toBe(true)
  })

  it('rejects other image names', () => {
    expect(isExternalCoverName('/dir/artwork.jpg')).toBe(false)
    expect(isExternalCoverName('/dir/cover.gif')).toBe(false)
  })
})

describe('naturalCompare', () => {
  it('orders track2 before track10 (numeric-aware)', () => {
    expect(naturalCompare('track2', 'track10')).toBeLessThan(0)
    expect(naturalCompare('track10', 'track2')).toBeGreaterThan(0)
  })

  it('returns 0 for equal strings', () => {
    expect(naturalCompare('chapter 07', 'chapter 07')).toBe(0)
  })

  it('compares mixed text/number segments left to right', () => {
    expect(naturalCompare('disc1track9', 'disc1track10')).toBeLessThan(0)
    expect(naturalCompare('disc2track1', 'disc1track99')).toBeGreaterThan(0)
  })

  it('sorts a shorter prefix string first', () => {
    expect(naturalCompare('track', 'track2')).toBeLessThan(0)
  })
})

describe('sortAudioFilesNaturally', () => {
  it('sorts by basename with numeric awareness', () => {
    const files = [
      '/books/x/Chapter 10.mp3',
      '/books/x/Chapter 2.mp3',
      '/books/x/Chapter 1.mp3'
    ]
    expect(sortAudioFilesNaturally(files)).toEqual([
      '/books/x/Chapter 1.mp3',
      '/books/x/Chapter 2.mp3',
      '/books/x/Chapter 10.mp3'
    ])
  })

  it('is directory-aware: differing parent directories are compared naturally before filename', () => {
    // Superseded intended semantics: this used to ignore directories and
    // compare only basenames, which silently interleaved same-numbered
    // tracks across a multi-disc book's disc folders (e.g. "CD1/01.mp3"
    // and "CD2/01.mp3" tying on basename). Directory segments are now
    // compared first (naturally), so '/a-dir/...' sorts before '/z-dir/...'.
    const files = ['/z-dir/01.mp3', '/a-dir/02.mp3']
    expect(sortAudioFilesNaturally(files)).toEqual(['/a-dir/02.mp3', '/z-dir/01.mp3'])
  })

  it('orders a multi-disc layout disc-major, track-minor instead of interleaving by filename', () => {
    const files = [
      '/book/CD2/01.mp3',
      '/book/CD1/02.mp3',
      '/book/CD2/02.mp3',
      '/book/CD1/01.mp3'
    ]
    expect(sortAudioFilesNaturally(files)).toEqual([
      '/book/CD1/01.mp3',
      '/book/CD1/02.mp3',
      '/book/CD2/01.mp3',
      '/book/CD2/02.mp3'
    ])
  })

  it('orders disc folders naturally (Disc 2 before Disc 10), not lexically', () => {
    const files = ['/book/Disc 10/01.mp3', '/book/Disc 2/01.mp3']
    expect(sortAudioFilesNaturally(files)).toEqual(['/book/Disc 2/01.mp3', '/book/Disc 10/01.mp3'])
  })

  it('does not mutate the input array', () => {
    const files = ['/x/b2.mp3', '/x/b1.mp3']
    const copy = [...files]
    sortAudioFilesNaturally(files)
    expect(files).toEqual(copy)
  })

  it('handles zero-padded vs unpadded numbering consistently', () => {
    const sorted = sortAudioFilesNaturally(['/x/track010.mp3', '/x/track2.mp3'])
    expect(sorted.map((f) => f.split('/').pop())).toEqual(['track2.mp3', 'track010.mp3'])
  })
})
