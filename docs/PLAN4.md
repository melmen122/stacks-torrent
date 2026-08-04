# Phase 4 — Pre-download safety check (local-only)

Goal: before any file *content* is downloaded, inspect the torrent's file manifest (available from metadata) and download ONLY audio files, skipping/refusing executables, disguised files, and archives. Local-only — no network calls, no VirusTotal, no external AV. This is a first line of defense against fake "audiobook" torrents that bundle malware; it is NOT a replacement for OS antivirus and CANNOT detect malware hidden inside a valid audio file. UI must say so.

## Core pure module (new): electron/lib/safetyCheck.js
`classifyTorrentFiles(files)` where files = `[{ name, length }]` (name = torrent-relative path).
Returns:
```
{
  verdict: 'clean' | 'caution' | 'danger',
  hasAudio: boolean,
  audio:   [{ name, length }],            // to be selected for download
  skipped: [{ name, category, reason }],  // everything not downloaded
  counts:  { audio, companion, archive, executable, disguised, other }
}
```
Classification (case-insensitive, by final extension unless noted). Reuse ALLOWED_AUDIO_EXTENSIONS from metadata.js as the audio set (.mp3 .m4a .m4b .aac .flac .ogg .opus .wav):
- **audio** → download.
- **executable** (DANGER): .exe .scr .bat .cmd .com .msi .vbs .vbe .js .jse .jar .lnk .ps1 .psm1 .apk .dll .sys .pkg .app .dmg .deb .rpm .sh .bin .reg .hta .cpl .msc .wsf .scf .gadget .jar
- **disguised** (DANGER): a file whose FINAL extension is executable AND it has a preceding extension that looks like a media/document file (e.g. `Chapter 1.mp3.exe`, `cover.jpg.scr`). Detect: split on '.', if final ext ∈ executable set and there are ≥2 extension segments → disguised (report both the fake and real extension in `reason`). (Plain single-extension executables are category 'executable'.)
- **archive** (CAUTION): .zip .rar .7z .tar .gz .bz2 .xz .iso .cab
- **companion** (benign, skipped silently in audio-only mode, not alarming): .jpg .jpeg .png .webp .gif .bmp .nfo .txt .cue .m3u .m3u8 .pdf .epub .mobi .srt .vtt .sub .opf .json
- **other** (unknown ext or no ext): CAUTION-level, skipped, reported as "unrecognized".

Verdict: `danger` if any executable/disguised; else `caution` if any archive or other; else `clean`.
`hasAudio` = audio.length > 0.

Keep this module pure (no electron/fs/app) and fully unit-testable.

## Backend wiring (electron/lib/torrents.js, main.js, preload.cjs)
- Add torrents with content download deferred until classification. Verify the webtorrent v3 mechanism in installed source: add with `{ deselect: true }` if supported (so nothing is selected on add), OR immediately `torrent.deselect(0, torrent.pieces.length-1, false)` / per-file `file.deselect()` right after 'metadata'. Whichever reliably prevents fetching non-audio content. The audio files get `file.select()`; risky/other files stay deselected. NET REQUIREMENT: a non-audio file's bytes must never be written to disk.
- On the torrent's 'metadata' (file list known), run classifyTorrentFiles(torrent.files.map(f=>({name:f.path||f.name, length:f.length}))), select only audio, store the report on the torrent summary + persist meta, and broadcast event `torrents:safety-report` { infoHash, name, verdict, hasAudio, downloadedCount: audio.length, skipped }.
- **No-audio guard**: if hasAudio === false, select nothing (download stays at 0), set the summary state to a distinct `noAudio` flag, and broadcast the report with verdict (danger if executables present, else caution) + hasAudio:false. Do NOT auto-remove; let the user remove it (renderer will prompt). Do not leave it "downloading" forever — it just sits at 0% with the noAudio flag; that's fine.
- torrents:list summary gains: `safety: { verdict, hasAudio, skippedCount } | null` (null = metadata not yet arrived / still checking). handleDone/auto-import already only imports audio extensions, so no change needed there, but confirm skipped files aren't in the imported book.
- On restart/restorePersisted: metadata is already on disk so classification re-runs quickly; persist the report so the badge shows immediately if available, but re-derive on metadata to be safe.
- preload: add `onSafetyReport(cb)` → unsubscribe. Event channel `torrents:safety-report`.
- Persistence: it's fine to include `safety` in torrents.json entries, but re-classification on metadata is the source of truth.

## Frontend (src/renderer/**)
- TorrentRow: show a safety badge from summary.safety: clean = subtle ✓ (or nothing/green dot), caution = amber ⚠ with tooltip, danger = red ⛔. Show "checking…" while safety is null (metadata pending). Badge/row click opens a details view listing skipped files with category + reason (a small popover or inline expand — reuse existing patterns, no heavy modal needed unless cleaner).
- On `onSafetyReport`: toast. For `danger`, a prominent error/warning toast: e.g. "⛔ Blocked a suspicious file in \"<name>\": <file> — downloaded audio only." For `caution` a subtle info toast. For `clean` no toast (avoid noise) — or a quiet success; keep it minimal.
- No-audio case (hasAudio:false): render the torrent row with a clear "No audio found — nothing downloaded. This may not be an audiobook." state and a Remove action (reuse existing remove flow). Strong-warn if verdict danger.
- Add one honest sentence in the Downloads view (small helper text) or the Settings/Downloads area: "Downloads are limited to audio files; executables and archives are skipped automatically. This is not a full antivirus." Keep it unobtrusive.
- Update docs/design.md: safety badge, report details UI, toasts, no-audio state.

## Tests (tests/**, vitest)
Unit-test classifyTorrentFiles exhaustively: audio-only → clean/hasAudio; bundled .exe → danger + exe skipped; `book.mp3.exe` → disguised; mixed audio+cover+nfo → clean, companions skipped; archive present → caution; no audio (only exe/pdf) → hasAudio false + correct verdict; case-insensitivity (.MP3, .ExE); no-extension file → other/caution; counts correct. Keep the suite green (currently 97 tests).

## Out of scope (state honestly, don't build)
- VirusTotal / online hash lookups (datacenter dependency — user chose local-only).
- Bundled AV engine (ClamAV etc.).
- Scanning inside valid audio files.
- A user-configurable enforcement mode (warn/block/audio-only) — default audio-only only, this round.
