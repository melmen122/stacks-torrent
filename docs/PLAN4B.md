# Phase 4B — VirusTotal hash scanning (post-download layer)

Builds ON TOP of PLAN4 (local pre-download manifest check). Does NOT replace it.
Layer 1 (PLAN4): manifest classification blocks executables/archives from ever downloading.
Layer 2 (this): downloaded files are hashed and looked up on VirusTotal to catch known malware inside files that passed layer 1.

## Why post-download
VirusTotal identifies files by content hash. A torrent manifest has only names/sizes, so a hash cannot exist before content arrives. Therefore VT runs AFTER a torrent completes (or per-file as pieces finish), BEFORE the user plays/relies on the book. This must be stated honestly in the UI — do not imply VT scans before downloading.

## Opt-in + key
- Disabled by default. Enabled only when the user supplies a VirusTotal API key in Settings.
- Key stored in `settings.json` (userData) as `virusTotalApiKey`. Plaintext local file — acceptable for a personal local app; note it in the Settings caption. NEVER log the key, never include it in error messages/toasts sent to the renderer.
- Settings additions: `virusTotalEnabled: boolean` (implicitly false when no key), `virusTotalApiKey: string|null`.

## Core module (new): electron/lib/virusTotal.js
Pure-ish (fs for hashing, fetch for network; no electron `app`) so it's testable with paths injected.
- `hashFile(filePath)` → SHA-256 hex, streamed via node:crypto createHash + createReadStream (must handle multi-GB files without loading into memory).
- `lookupHash(sha256, apiKey, { fetchImpl })` → GET `https://www.virustotal.com/api/v3/files/<sha256>` with header `x-apikey: <key>`. Handle explicitly:
  - 200 → parse `data.attributes.last_analysis_stats` → `{ status:'known', malicious, suspicious, harmless, undetected, permalink }`
  - 404 → `{ status:'unknown' }` (file never seen by VT — NOT a threat signal, must not be shown as "clean" nor as "bad"; it's genuinely unknown)
  - 401/403 → `{ status:'auth-error' }` (bad key)
  - 429 → `{ status:'rate-limited', retryAfterMs }` (back off, requeue)
  - other/network failure → `{ status:'error', message }` (never throw into the caller's flow)
- NEVER upload file content. Hash lookups only. (VT's upload endpoint is explicitly out of scope: privacy + multi-GB audiobooks.)
- Verdict mapping: `malicious >= 1` → `infected`; `suspicious >= 2 && malicious === 0` → `suspicious`; `status==='known' && malicious===0 && suspicious<2` → `clean`; unknown → `unknown`.

## Scan queue (electron/lib/scanQueue.js or inside virusTotal.js)
- Rate limit: default 4 requests/minute (free tier). Make the interval a constant, configurable via settings later. Serialize requests through a timer-based queue; on 429 back off and retry with exponential delay (cap ~5 min), do not drop the item.
- Dedupe: identical SHA-256 within a batch → one lookup.
- Persistent cache: `userData/vt-cache.json` mapping `sha256 → { verdict, malicious, suspicious, checkedAt }`. Cache hits are free and instant; never re-look-up a cached hash (add a TTL of e.g. 30 days, then re-check).
- Hashing is CPU/IO work: run it sequentially in the background; must not block the main thread's responsiveness (consider chunked streaming; if it stalls the UI, move hashing to a worker_thread — verify before shipping).
- Queue survives nothing (in-memory) — on restart, unscanned books are re-queued from library state (see below).

## Triggering
- After `handleDone` imports a book (PLAN4 flow), enqueue that book's audio files for scanning if VT is enabled.
- Also allow manual: `virusTotal:scanBook(bookId)` IPC for a re-scan / scanning previously imported books.
- On app start, if VT enabled, enqueue books whose `scan` field is missing/stale (bounded — don't flood; process in background at the rate limit).

## Data model (library.json, additive + backward compatible)
`book.scan = { state: 'unscanned'|'scanning'|'done'|'error', verdict: 'clean'|'suspicious'|'infected'|'unknown'|null, scannedAt: number|null, files: [{ name, sha256, verdict, malicious, suspicious }] } | null`
Books without the field behave as `unscanned`.

## IPC contract
Invoke:
- `virusTotal:getSettings` → `{ enabled: boolean, hasKey: boolean }` (NEVER return the key itself to the renderer)
- `virusTotal:setKey(key: string|null)` → validates by doing one lookup of a known-harmless hash (e.g. SHA-256 of the empty string / EICAR is NOT appropriate to fetch — use a trivial known hash or just call the /users endpoint) → `{ ok, valid, reason }`; persists on success; passing null clears it and disables.
- `virusTotal:scanBook(bookId)` → `{ queued: boolean }`
Events:
- `virusTotal:scan-progress` → `{ bookId, done, total }`
- `virusTotal:scan-complete` → `{ bookId, verdict, infectedFiles: [{name, malicious}] }`
Preload: `virusTotalGetSettings()`, `virusTotalSetKey(key)`, `virusTotalScanBook(bookId)`, `onScanProgress(cb)`, `onScanComplete(cb)`.

## Frontend
- Settings → new "Virus scanning (VirusTotal)" section: enable/disable, API key input (type=password, never displayed back — show "key saved" state instead), "Get a free key" link text to virustotal.com (plain text or external-open, no auto-open), status line, and an honest caption: scans run AFTER download using file hashes sent to VirusTotal; hashes only, never file contents; free tier is rate-limited so large audiobooks scan slowly in the background; this complements but does not replace your OS antivirus.
- BookCard: small scan badge — scanning (spinner/subtle), clean ✓, unknown (neutral "not in VT database" — must NOT read as clean or as danger), suspicious ⚠, infected ⛔ (prominent red).
- Infected → prominent persistent alert on the card + a toast on `scan-complete`, with actions: reveal in file manager / remove book (reuse existing remove flow with deleteFiles). Do NOT auto-delete the user's files.
- Book detail/menu: "Scan for viruses" action calling scanBook (and re-scan when already scanned).
- docs/design.md: document badge states (esp. that `unknown` ≠ clean), settings section, alerts.

## Tests
- Pure logic only, no live network: verdict mapping (malicious>=1 → infected; suspicious thresholds; unknown), response parsing for 200/404/401/429/malformed JSON, cache TTL logic, dedupe, rate-limiter scheduling (injectable clock), hashFile against a temp fixture with a known SHA-256. Inject `fetchImpl` — never hit the real API in tests.
- Keep the suite green.

## Honesty constraints (must hold in UI + docs)
- Never claim VT scans before downloading.
- `unknown` must never render as "safe".
- State that hashes (not file contents) leave the machine, and that this is the one part of the app that contacts an external service.
- Not a replacement for OS antivirus.

## Out of scope
- Uploading files to VT for analysis of unknown hashes.
- Paid-tier throughput assumptions.
- Real-time scanning during download (pieces are not complete files).
