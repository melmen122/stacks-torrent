// electron/lib/metadata.js
//
// Metadata scanning for audiobook files. No dependency on `electron`'s `app`
// module so this file stays importable/testable outside of a running app —
// callers pass in all filesystem paths explicitly.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parseFile, selectCover } from 'music-metadata'

export const ALLOWED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.m4b',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wav'
]

const ALLOWED_AUDIO_EXT_SET = new Set(ALLOWED_AUDIO_EXTENSIONS)

const EXTERNAL_COVER_NAMES = new Set([
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'folder.jpg',
  'folder.jpeg',
  'folder.png'
])

/** True if the given path has an allowed audiobook audio extension. */
export function isAudioFile(filePath) {
  return ALLOWED_AUDIO_EXT_SET.has(path.extname(filePath).toLowerCase())
}

/** True if the given filename looks like a common "external" cover image. */
export function isExternalCoverName(filePath) {
  return EXTERNAL_COVER_NAMES.has(path.basename(filePath).toLowerCase())
}

/**
 * Numeric-aware comparison of two strings, e.g. "track2" sorts before
 * "track10". Used to order multi-file audiobooks correctly.
 */
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g
  const ax = []
  const bx = []
  let m
  while ((m = re.exec(a))) ax.push([m[1] ? Number(m[1]) : Infinity, m[1] ? '' : m[2]])
  re.lastIndex = 0
  while ((m = re.exec(b))) bx.push([m[1] ? Number(m[1]) : Infinity, m[1] ? '' : m[2]])

  const len = Math.max(ax.length, bx.length)
  for (let i = 0; i < len; i++) {
    const an = ax[i]
    const bn = bx[i]
    if (!an) return -1
    if (!bn) return 1
    if (an[0] !== bn[0]) return an[0] - bn[0]
    const cmp = an[1].localeCompare(bn[1])
    if (cmp !== 0) return cmp
  }
  return 0
}

/**
 * Numeric-aware AND directory-aware comparison of two absolute file paths:
 * compares path segments (directory components, then filename) left to
 * right using `naturalCompare` per segment, rather than comparing only the
 * final filename. Two files that share every directory segment only ever
 * differ at the filename, so this is equivalent to a plain basename compare
 * whenever both paths have the same parent (the common single-directory
 * multi-file book case) — but it's what makes a multi-disc layout order
 * disc-major/track-minor ("CD1/01.mp3", "CD1/02.mp3", ..., "CD2/01.mp3", ...)
 * instead of interleaving same-numbered tracks across discs by filename alone.
 */
function compareFilePaths(a, b) {
  const segA = a.split(path.sep).filter(Boolean)
  const segB = b.split(path.sep).filter(Boolean)
  const len = Math.max(segA.length, segB.length)
  for (let i = 0; i < len; i++) {
    const sa = segA[i]
    const sb = segB[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (sa === sb) continue
    return naturalCompare(sa, sb)
  }
  return 0
}

/**
 * Sort a list of absolute file paths naturally and directory-aware (see
 * `compareFilePaths`). This is the single canonical ordering used by
 * `scanBookFiles` for every import path — native dialog, drag & drop
 * (via importGrouping.js), and torrent auto-import (handleDone in
 * torrents.js) all funnel through here, so fixing ordering in one place
 * covers all of them.
 */
export function sortAudioFilesNaturally(files) {
  return [...files].sort((a, b) => compareFilePaths(a, b))
}

/**
 * Scan a group of files that together make up one audiobook.
 *
 * @param {string[]} files - absolute paths, will be filtered to audio files and sorted.
 * @param {object} opts
 * @param {string} opts.bookId - id used to name the extracted cover file.
 * @param {string} [opts.coversDir] - directory covers should be written into.
 * @param {string} [opts.folderName] - fallback title source (e.g. containing folder name).
 * @param {string[]} [opts.extraCoverCandidates] - non-audio sibling file paths to check
 *   for a "cover.jpg"/"folder.jpg" style external cover image if no embedded art is found.
 * @returns {Promise<{files:string[], title:string, author:string, durationSec:number|null, suggestedGenre:string|null, coverPath:string|null, chapters:Array<{title:string,fileIndex:number,startSec:number}>|null}>}
 */
export async function scanBookFiles(files, opts = {}) {
  const { bookId, coversDir, folderName = null, extraCoverCandidates = [] } = opts

  const sorted = sortAudioFilesNaturally(files.filter(isAudioFile))
  // Chapters are only ever stored for single-file books (see docs/PLAN2.md);
  // multi-file books derive their chapter list from `files` in the renderer.
  const isSingleFileBook = sorted.length === 1

  let totalDuration = 0
  let hasDuration = false
  let title = null
  let author = null
  let suggestedGenre = null
  let coverPath = null
  let chapters = null

  for (let i = 0; i < sorted.length; i++) {
    const file = sorted[i]
    let meta = null
    try {
      // `includeChapters` only costs anything for single-file books, and is
      // requested only there (see chapter-parsing note below).
      meta = await parseFile(file, isSingleFileBook ? { duration: true, includeChapters: true } : { duration: true })
    } catch {
      if (isSingleFileBook) {
        // Some MP4 chapter-track layouts make music-metadata's chapter parser
        // throw instead of just omitting chapters (verified: e.g. certain
        // ffmpeg-authored files where multiple chapter-text samples share one
        // `mdat` chunk instead of one chunk per sample — a real, reproducible
        // bug in music-metadata@11.14.0's MP4Parser#parseChapterTrack, not
        // specific to this app). Retry without `includeChapters` so basic
        // metadata (title/author/duration/cover) is never lost just because
        // chapter parsing itself is what failed.
        try {
          meta = await parseFile(file, { duration: true })
        } catch {
          continue
        }
      } else {
        // Unreadable/corrupt file — skip metadata for it but keep it in the playlist.
        continue
      }
    }

    const duration = meta?.format?.duration
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      totalDuration += duration
      hasDuration = true
    }

    if (i === 0) {
      const common = meta?.common ?? {}
      title = common.title || null
      author = common.artist || common.albumartist || null
      suggestedGenre = Array.isArray(common.genre) && common.genre.length ? common.genre[0] : null

      if (coversDir && bookId && Array.isArray(common.picture) && common.picture.length) {
        const picture = selectCover(common.picture) || common.picture[0]
        coverPath = await saveEmbeddedCover(picture, coversDir, bookId)
      }

      if (isSingleFileBook) {
        chapters = extractChapters(meta?.format?.chapters)
      }
    }
  }

  if (!coverPath && coversDir && bookId) {
    coverPath = await saveExternalCover(extraCoverCandidates, coversDir, bookId)
  }

  if (!title) {
    if (folderName) {
      title = folderName
    } else if (sorted.length) {
      title = path.basename(sorted[0], path.extname(sorted[0]))
    } else {
      title = 'Unknown title'
    }
  }
  if (!author) author = 'Unknown author'

  return {
    files: sorted,
    title,
    author,
    durationSec: hasDuration ? Math.round(totalDuration) : null,
    suggestedGenre,
    coverPath,
    chapters
  }
}

/**
 * Map music-metadata's raw `format.chapters` (shape varies by container: MP4
 * QuickTime-style chapter tracks use `{title, start, timeScale}` where
 * seconds = start/timeScale; ID3v2 CHAP/CTOC frames in mp3 use
 * `{title, start}` where `start` is already in seconds) into our stored
 * shape. Both are genuinely populated by music-metadata@11.14.0 — verified
 * directly against its installed source with real ffmpeg-authored fixtures
 * of both container types, through this exact function. One real mp3-side
 * caveat: music-metadata itself requires a CHAP frame to carry a nested
 * TIT2 (title) subframe or it drops that chapter entirely (`title is
 * required`, ID3v2Parser.js), so an mp3 whose authoring tool wrote chapter
 * markers without per-chapter titles won't surface any chapters here.
 * Returns null if there's nothing usable.
 */
function extractChapters(rawChapters) {
  if (!Array.isArray(rawChapters) || !rawChapters.length) return null
  const mapped = rawChapters
    .map((c) => {
      // music-metadata's MP4Parser emits `timeScale: 0` when the chapter
      // track's own media header is missing/unreadable. Defaulting that to
      // 1 (like a genuinely absent timeScale) would silently treat raw
      // media-clock units as seconds — drop the chapter instead of
      // reporting a bogus position.
      if (c.timeScale === 0) return null
      const timeScale = typeof c.timeScale === 'number' && c.timeScale > 0 ? c.timeScale : 1
      const startSec = typeof c.start === 'number' ? c.start / timeScale : null
      const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : null
      if (startSec === null || title === null) return null
      return { title, fileIndex: 0, startSec }
    })
    .filter(Boolean)
  return mapped.length ? mapped : null
}

async function saveEmbeddedCover(picture, coversDir, bookId) {
  try {
    await fs.mkdir(coversDir, { recursive: true })
    const dest = path.join(coversDir, `${bookId}.jpg`)
    await fs.writeFile(dest, picture.data)
    return dest
  } catch {
    return null
  }
}

async function saveExternalCover(candidates, coversDir, bookId) {
  for (const candidate of candidates) {
    if (!isExternalCoverName(candidate)) continue
    try {
      await fs.mkdir(coversDir, { recursive: true })
      const dest = path.join(coversDir, `${bookId}.jpg`)
      await fs.copyFile(candidate, dest)
      return dest
    } catch {
      // try next candidate
    }
  }
  return null
}
