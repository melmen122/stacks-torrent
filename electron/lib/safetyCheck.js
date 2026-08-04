// electron/lib/safetyCheck.js
//
// Pure, local-only pre-download safety classification for a torrent's file
// manifest (see docs/PLAN4.md). No electron/fs/network dependency — operates
// purely on the `[{name, length}]` shape webtorrent's `torrent.files` already
// exposes (name = torrent-relative path), so it's fully unit-testable
// without a running torrent client.
//
// This is a FIRST LINE OF DEFENSE against fake "audiobook" torrents that
// bundle malware (executables, disguised files, archives) — NOT a
// replacement for OS antivirus, and it CANNOT detect malware hidden inside a
// genuinely valid audio file. Classification is by file extension only.
//
// Note on what a wrong VERDICT here does and doesn't affect: the actual
// download-blocking decision (electron/lib/torrents.js) selects ONLY files
// classified as `audio` (plus small cover images, docs/PLAN4B.md) — an
// executable is never selected/downloaded regardless of whether it's
// correctly labeled 'executable'/'disguised' (danger) or falls through to
// 'other' (mere caution) due to some unhandled adversarial filename. A
// verdict miss here is a BADGE/UI-accuracy bug, not a download-safety hole
// — but it's still fixed properly below (normalization + wider sets) so the
// badge users see is trustworthy too.

import { ALLOWED_AUDIO_EXTENSIONS } from './metadata.js'

const AUDIO_EXT_SET = new Set(ALLOWED_AUDIO_EXTENSIONS)

// DANGER: executables, in all the forms an "audiobook" torrent could
// plausibly try to smuggle one in as — Windows/macOS/Linux native
// executables and installers, script interpreters, and shortcut/link files
// that can themselves launch arbitrary commands.
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.scr', '.bat', '.cmd', '.com', '.msi', '.vbs', '.vbe', '.js', '.jse',
  '.jar', '.lnk', '.ps1', '.psm1', '.apk', '.dll', '.sys', '.pkg', '.app', '.dmg',
  '.deb', '.rpm', '.sh', '.bin', '.reg', '.hta', '.cpl', '.msc', '.wsf', '.scf',
  '.gadget',
  // macOS script/automation forms.
  '.command', '.workflow', '.terminal', '.action', '.applescript',
  // Additional script interpreters.
  '.py', '.rb', '.pl', '.csh', '.zsh', '.php', '.jsp',
  // Java/Windows/Linux packages and installers.
  '.war', '.msix', '.appx', '.msp', '.job',
  // Shortcut-style files that can launch arbitrary targets/commands.
  '.url', '.website', '.desktop', '.pif'
])

// CAUTION: archives — not scanned or extracted, so their contents are
// unknown; also generically CAUTION as "other" below if unrecognized.
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab',
  '.tgz', '.lz', '.zst', '.arj', '.lha', '.z', '.001'
])

// Benign, skipped silently in audio-only mode (never affects verdict) —
// covers, liner notes, playlists, subtitles, e-book companions, etc. A
// small subset (image files, see `COVER_IMAGE_EXTENSIONS`) is additionally
// surfaced in the `covers` return field as selectable for download.
const COMPANION_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.nfo', '.txt', '.cue',
  '.m3u', '.m3u8', '.pdf', '.epub', '.mobi', '.srt', '.vtt', '.sub', '.opf', '.json'
])

// Cover-image selection (docs/PLAN4B.md): a small image is downloaded even
// under audio-only mode, purely as a fallback for scanBookFiles' external
// cover-art lookup — it stays classified/reported as 'companion' (never
// audio, never imported as book content).
const COVER_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
export const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB

// Zero-width and bidi-override Unicode control characters, sometimes used
// to visually disguise a filename's real extension in a file browser (the
// classic "RTL override" trick: e.g. a file literally ending in ".exe" is
// made to *display* as if it ends in ".jpg" by inserting U+202E earlier in
// the name). Stripped before classification so they can never interfere
// with matching — classification always reflects the file's REAL trailing
// extension bytes, which is also what the OS itself uses to decide
// execution behavior (the visual trick fools a human reading a file list,
// not a raw string split like this one).
const UNICODE_CONTROL_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * All extension segments of a filename, lowercased, in order — e.g.
 * "Chapter 1.mp3.exe" -> ['.mp3', '.exe']. A name with no extension, or a
 * dotfile-style name with no "real" extension before the first dot (e.g.
 * ".gitattributes"), yields [].
 *
 * Normalizes away two things before splitting: Unicode bidi/zero-width
 * control characters (see above), and trailing dots/spaces — Windows
 * treats "evil.exe" and "evil.exe. " (or any trailing run of dots/spaces)
 * as the same file for execution purposes, so classification must too,
 * rather than letting a trivially-appended trailing dot/space downgrade an
 * executable to an unrecognized "other".
 */
function extensionSegments(name) {
  const cleaned = String(name ?? '').replace(UNICODE_CONTROL_CHARS_RE, '')
  const base = cleaned.split(/[\\/]/).pop() ?? ''
  const normalizedBase = base.replace(/[.\s]+$/, '')
  const parts = normalizedBase.split('.')
  if (parts.length <= 1 || parts[0] === '') return []
  return parts.slice(1).map((p) => `.${p.trim().toLowerCase()}`)
}

function isCoverImageCandidate(file) {
  const segments = extensionSegments(file?.name)
  const finalExt = segments.length ? segments[segments.length - 1] : ''
  if (!COVER_IMAGE_EXTENSIONS.has(finalExt)) return false
  const length = Number(file?.length)
  return Number.isFinite(length) && length >= 0 && length <= MAX_COVER_IMAGE_BYTES
}

function classifyOne(file) {
  const name = file?.name ?? ''
  const segments = extensionSegments(name)
  const finalExt = segments.length ? segments[segments.length - 1] : ''

  if (AUDIO_EXT_SET.has(finalExt)) {
    return { category: 'audio', reason: null }
  }

  if (EXECUTABLE_EXTENSIONS.has(finalExt)) {
    if (segments.length >= 2) {
      const fakeExt = segments[segments.length - 2]
      return {
        category: 'disguised',
        reason: `fake extension "${fakeExt}" hides the real executable extension "${finalExt}"`
      }
    }
    return { category: 'executable', reason: `executable file ("${finalExt}")` }
  }

  if (ARCHIVE_EXTENSIONS.has(finalExt)) {
    return { category: 'archive', reason: `archive file ("${finalExt}") — not scanned or extracted` }
  }

  if (COMPANION_EXTENSIONS.has(finalExt)) {
    return { category: 'companion', reason: `non-audio companion file ("${finalExt}")` }
  }

  return {
    category: 'other',
    reason: finalExt ? `unrecognized file type ("${finalExt}")` : 'unrecognized file type (no extension)'
  }
}

/**
 * Classify a torrent's file manifest into what's safe to download (audio),
 * what small companion images are additionally selectable as a cover-art
 * fallback, and what to skip entirely, with an overall verdict.
 *
 * @param {Array<{name: string, length: number}>} files - torrent-relative
 *   paths, as webtorrent's `torrent.files[].path`/`.name` provide.
 * @returns {{
 *   verdict: 'clean'|'caution'|'danger',
 *   hasAudio: boolean,
 *   audio: Array<{name:string, length:number}>,
 *   covers: Array<{name:string, length:number}>,
 *   skipped: Array<{name:string, category:string, reason:string}>,
 *   counts: {audio:number, companion:number, archive:number, executable:number, disguised:number, other:number}
 * }}
 */
export function classifyTorrentFiles(files) {
  const list = Array.isArray(files) ? files : []
  const audio = []
  const covers = []
  const skipped = []
  const counts = { audio: 0, companion: 0, archive: 0, executable: 0, disguised: 0, other: 0 }

  for (const file of list) {
    const { category, reason } = classifyOne(file)
    counts[category] = (counts[category] ?? 0) + 1
    if (category === 'audio') {
      audio.push({ name: file.name, length: file.length })
    } else {
      skipped.push({ name: file.name, category, reason })
      if (category === 'companion' && isCoverImageCandidate(file)) {
        covers.push({ name: file.name, length: file.length })
      }
    }
  }

  const baseVerdict =
    counts.executable > 0 || counts.disguised > 0
      ? 'danger'
      : counts.archive > 0 || counts.other > 0
        ? 'caution'
        : 'clean'

  // A non-empty manifest that contains NO audio at all must never silently
  // read as "clean" — "claims to be an audiobook, contains zero audio" is
  // itself noteworthy (most likely not a real audiobook, or a fake/decoy
  // torrent) and needs to surface to the user, not be swallowed by the
  // no-toast-on-clean UI convention. Only escalates a would-be-`clean`
  // verdict (danger/caution from actual risky files always wins regardless
  // of audio presence), and only when the manifest is genuinely non-empty
  // — an empty input list stays 'clean' (nothing to warn about).
  const verdict = baseVerdict === 'clean' && list.length > 0 && audio.length === 0 ? 'caution' : baseVerdict

  return {
    verdict,
    hasAudio: audio.length > 0,
    audio,
    covers,
    skipped,
    counts
  }
}
