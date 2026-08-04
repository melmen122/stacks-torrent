# Design System — Stacks (Audiobook Library)

Source of truth for the renderer UI (`src/renderer/**`). Update this file whenever a
pattern changes or a new one is introduced.

## Vibe
A calm, dark "reading room" for audiobooks — near-black charcoal background, warm amber
accent (evokes a reading lamp / book spine), generous spacing, soft elevation instead of
heavy borders. Not skeuomorphic, not corporate SaaS — closer to a premium media library app.

## Palette (CSS custom properties, `styles/variables.css`)
| Token | Value | Use |
|---|---|---|
| `--bg-base` | `#14151a` | App background |
| `--bg-elevated` | `#1b1d24` | Sidebar, cards, player bar, dialogs |
| `--bg-elevated-2` | `#22242e` | Nested surfaces (inputs, menus, progress tracks) |
| `--bg-hover` | `#2a2d39` | Hover state for rows/buttons on elevated surfaces |
| `--border-subtle` / `--border-strong` | `rgba(255,255,255,.07)` / `.14` | Hairline separators |
| `--text-primary` / `--text-secondary` / `--text-tertiary` | `#f2f3f7` / `#a4a9b8` / `#6d7180` | Text hierarchy |
| `--accent` / `--accent-hover` | `#f2a541` / `#f7b869` | Primary actions, active nav/genre, play button, sliders |
| `--accent-text` | `#1a1305` | Text on accent-filled surfaces |
| `--accent-muted-bg` | `rgba(242,165,65,.14)` | Active-state background (nav, genre chip, focus ring) |
| `--success` / `--success-bg` | `#4fb286` / translucent | Completed downloads, success toasts |
| `--danger` / `--danger-hover` / `--danger-bg` | `#e26a6a` / `#eb8484` / translucent | Destructive actions (remove, delete) |
| `--info` | `#5b8def` | Info toast accent |

Book covers with no embedded art get a deterministic two-color diagonal gradient (`utils/color.js`,
`gradientFor(seed)`), hashed from title+author, drawn from a fixed 8-color palette so the same
book always gets the same look. Initials (1–2 letters of the title) are overlaid in white.

## Typography
System font stack (`-apple-system, "Segoe UI", Roboto, ...`). Scale: `--fs-xs` 12 / `--fs-sm` 13 /
`--fs-base` 14 (body default) / `--fs-md` 16 / `--fs-lg` 20 / `--fs-xl` 24 / `--fs-xxl` 32.
Headings are bold (700) with slightly tightened letter-spacing (`-0.01em`); labels/eyebrows
(e.g. "GENRES" section header) are uppercase, 12px, letter-spacing `0.06em`, tertiary color.

## Spacing scale
4px base: `--space-1..7` = 4, 8, 12, 16, 24, 32, 48px. Card/section gaps typically use
`--space-5` (24px); internal component padding uses `--space-3`/`--space-4`.

## Radii & elevation
`--radius-sm` 6px (inputs, small chips), `--radius-md` 10px (buttons, menus), `--radius-lg` 16px
(cards, dialogs, torrent rows), `--radius-full` (pills, chips, sliders, count badges).
Shadows: `--shadow-sm/md/lg` — cards use `md` on hover, dialogs/player bar use `lg`.

## Layout
- `.app-shell`: full-height column — `.app-body` (sidebar + main, flexes to fill) then the
  persistent `.player-bar` below it, so the player never overlaps content.
- Sidebar: fixed `--sidebar-width` (264px), own scroll region.
- Main content (`.app-main`): flexible, scrolls independently, generous outer padding
  (`--space-6`/`--space-7`).
- Player bar: fixed height `--player-height` (92px), only rendered when a book is loaded.

## Component inventory
- **Sidebar** (`Sidebar.jsx`) — brand mark, primary nav (Library/Downloads/Settings), Genres
  section with All Books / Uncategorized (live counts) + user genres. `+` button reveals an
  inline create-genre input (Enter to submit, Escape/blur to cancel).
- **GenreRow** — hover-revealed `⋯` icon-button opens an `IconMenu` (Rename / Delete). Rename
  swaps the row for an inline text input; Delete opens a `ConfirmDialog`.
- **Toolbar** — search input (icon + text, filters title/author), sort `<select>`
  (Recently added / Title A–Z / Author A–Z), spacer, "Import books…" (ghost button),
  "Add torrent" (primary button, jumps to Downloads).
- **BookCard** — square cover (art or gradient+initials placeholder), hover play overlay
  (▶/⏸ depending on whether it's the active book), suggestion pill
  (`Suggested: <genre> ✓ ✕`) when `book.suggestedGenre` is set, title/author, duration,
  genre chip, a `ScanBadge` when a VirusTotal scan result exists for the book, `⋯` menu
  (assign genre — with a checkmark on the active one — "Scan for viruses"/"Re-scan for
  viruses" gated on a VirusTotal key being set (see below) — or remove from library via
  `ConfirmDialog` with an "also delete files" checkbox). A book whose scan verdict is
  `infected` gets a persistent red-tinted card border (`.book-card-infected`, not just a
  hover state) plus an always-visible (not dismissible) alert bar — "⛔ Infected file(s)
  detected by VirusTotal" — with its own "Remove…" link that opens the same
  `ConfirmDialog`/delete-files flow as the menu's remove action. Nothing is ever
  auto-deleted.
- **ScanBadge** — small pill reflecting a book's VirusTotal scan (`book.scan`, optionally
  overridden by a fresher in-session result — see Interaction patterns): a pulsing dot +
  "Scanning… (done/total)" while active, green "✓ Clean", amber "⚠ Suspicious", red "⛔
  Infected" (bold), and — this is the one that matters most — a **neutral gray** "? Unknown
  to VirusTotal" for files VT has no record of. `unknown` deliberately shares no styling
  with `clean`: same treatment as a muted/neutral badge, with a title tooltip spelling out
  that it is *not* a safety signal either way. Renders nothing at all when there's no scan
  data yet (VT is opt-in and off by default, so most books simply show no badge until the
  user enables it and a scan actually runs).
- **LibraryView** — combines Toolbar + grid, computes filtered/sorted book list, and picks the
  right `EmptyState` variant (no books at all vs. no search results).
- **DownloadsView** — magnet-link form (input + Add + "Open .torrent file…"), a small
  unobtrusive safety-scope caption ("Downloads are limited to audio files; executables and
  archives are skipped automatically. Not a full antivirus."), and a list of `TorrentRow`s.
- **TorrentRow** — name, progress bar, %, speed, peers, pause/resume (hidden once done),
  remove (with delete-files confirm), and a `SafetyBadge` when the backend reports
  `torrent.safety`. Completed torrents get a green-tinted border and a "Completed" label
  instead of live stats. A torrent whose safety check found no audio (`hasAudio: false`)
  swaps its progress bar/stats for a persistent message — "No audio found — nothing
  downloaded. This may not be an audiobook." — and hides pause/resume (nothing to
  pause/resume at 0%), leaving only Remove; the row gets a stronger red-tinted
  border/background if the verdict was `danger` (vs. a neutral muted tint otherwise).
- **SafetyBadge** — small pill next to a torrent's stats reflecting `torrent.safety` from
  `torrents:list` (`{ verdict, hasAudio, skippedCount } | null`): a pulsing gray dot +
  "Checking…" while `null` (metadata still pending), green "✓ Audio only" for `clean`, amber
  "⚠ Caution" for `caution`, red "⛔ Blocked risky file" for `danger`. Static (non-interactive)
  when nothing was skipped; becomes a clickable button with a skipped-file count bubble when
  `skippedCount > 0`, opening `SafetyDetails`. Only rendered at all once the field exists on
  the torrent object (`'safety' in torrent`), so it's simply absent — never stuck "Checking…"
  forever — against a backend that doesn't support the feature yet.
- **SafetyDetails** — read-only popover (click the safety badge) listing the files a
  torrent's safety check skipped: name, a category chip (companion/archive/
  executable/disguised/other, color-coded by severity), and the human-readable reason.
  Portaled to `document.body` with the same fixed-position/flip-upward/player-bar-aware/
  viewport-clamped pattern as `IconMenu` (deliberately a separate implementation — see its
  file comment for why). Per-file detail only ever arrives via the `onSafetyReport` event
  (`torrents:list` only carries the summary counts), so if a torrent has a nonzero
  `skippedCount` but no event has fired yet this session (e.g. right after app start before
  the backend re-broadcasts on restore), it shows "Details aren't available for this
  session — re-add the torrent to see specifics." rather than an empty/broken list.
- **PlayerBar** — persistent bottom bar: cover thumb, title/author (+ "File x of y" for
  multi-file books), prev/±30s/play-pause/±30s/next transport, seek bar with elapsed/total
  time, a chapters button, volume slider, close button. Only mounted while a book is loaded.
- **ChapterMenu** — popover opened from the player bar's chapters button, anchored *above*
  its trigger (`bottom: calc(100% + 10px)`) since the player bar sits at the bottom of the
  window. Lists chapters (title + start time), highlights the currently-playing one, closes
  on outside click/Escape (same pattern as `IconMenu`). Unlike `IconMenu` this one is *not*
  portaled — none of its ancestors (`.chapter-trigger`/`.player-side`/`.player-controls`/
  `.player-bar`) clip overflow, so plain `position: absolute` is safe here. Chapter source:
  `book.chapters` when present, else one derived chapter per file (see `utils/chapters.js`);
  see Interaction patterns below for the highlighting rule.
- **IconMenu** — generic floating dropdown (used by `BookCard`'s `⋯` menu and `GenreRow`'s
  rename/delete menu), supporting `danger`, `active` (checkmark), and `separator` items.
  Portaled to `document.body` and positioned with `position: fixed` computed from the
  trigger button's `getBoundingClientRect()` (passed in as `anchorRef`) rather than CSS
  `position: absolute` inside the trigger's own subtree — several ancestors (`.book-card`,
  `.app-main`, `.app-shell`, `.sidebar`) use `overflow: hidden`/`auto` for rounded corners
  and scroll containment, which used to silently clip the menu once it grew past ~1-2
  items. It flips to open upward when there isn't room below (treating the player bar's top
  edge as the effective floor when one is rendered, so it never opens behind/under the
  player controls) and clamps horizontally to stay within the viewport; caps at `max-height:
  260px` with internal scroll for long genre lists. Closes on outside click, Escape, or
  scroll/resize (closing rather than re-tracking on scroll keeps the fixed position from
  drifting off its anchor).
- **ConfirmDialog** — generic modal: title, message, optional labeled checkbox (used for
  "also delete files"), Cancel + Confirm (primary or danger).
- **SettingsView** — sidebar nav entry below Downloads (gear icon). Three section cards:
  - "Downloads": current download folder (from `settingsGet`), a "Change…" button
    (`settingsChooseDownloadDir` — a native folder picker; canceling returns `null` and shows
    no toast, picking a folder shows a success toast and refreshes the displayed value), and
    a caption clarifying that existing/in-progress downloads keep their original folder.
  - "Magnet links": default-handler status (from `systemIsDefaultMagnetHandler` — "Audiobook
    Library is your default magnet app ✓" in success green, or "Not the default" in muted
    text) and a "Make default" button (`systemSetDefaultMagnetHandler`) that refreshes the
    status and toasts: success if it's now confirmed default, a softer info toast ("Requested
    — you may need to confirm in your browser/OS") if registration succeeded but the OS
    hasn't confirmed it yet, or an error toast on failure. Caption notes the macOS
    confirmation prompt and that another client (e.g. uTorrent) may need to be changed in its
    own settings too.
  - "Virus scanning (VirusTotal)": status line ("Key saved ✓ — scanning enabled" / "Key
    saved, scanning is off" / "No key set — scanning disabled"), a `type="password"` key
    input that is **never** pre-filled or echoed back (the backend only ever returns
    `hasKey: boolean`, never the key itself) plus Save/"Clear key" (the clear button only
    appears once a key is saved), and two honest captions: plain-text guidance to get a free
    key at virustotal.com (text only — the app never auto-opens external links) and a
    disclosure that scans run *after* download using file hashes only (never file contents),
    this is the one feature that contacts an external service, the free tier is
    rate-limited so large libraries scan slowly in the background, an "unknown" result is
    explicitly **not** the same as "clean", this complements rather than replaces the OS's
    antivirus, and the key itself is stored locally in plain text.
- **DropImportOverlay** — invisible until a file drag enters the window; then shows a
  full-window dashed-border overlay ("Drop audiobooks to import"). On drop, resolves each
  dropped `File` to an absolute path via `getPathForFile` and calls `libraryImportPaths`.
  While that import is in flight the overlay stays visible in a distinct "busy" state (solid
  border, pulsing hourglass, "Importing… this can take a while for large folders") instead of
  disappearing the instant the drag ends — large-folder scans can take tens of seconds, and
  a second drop during that window is ignored rather than starting a duplicate import. Once
  it settles, the busy state clears and the normal result toast fires. See Interaction
  patterns for the drag-detection guard.
- **MagnetNavigator** — non-visual (renders `null`); on mount both (a) pulls
  `systemConsumePendingMagnet()` once — covers the cold-start case where the OS launched the
  app *via* the magnet click and main may have pushed the event before this subscription
  existed — and (b) subscribes to `onMagnetReceived` for the app's lifetime (the warm path:
  app already running). Either source switches the active view to Downloads and toasts
  "Magnet added — downloading…" (or, if the payload carries an `error`, "Couldn't add
  magnet: `<reason>`" as an error toast, still navigating to Downloads so the failure is
  visible). The torrent add itself already happened in the main process; this is purely
  navigation + feedback. A last-handled-magnet-plus-timestamp ref dedupes the case where the
  same magnet arrives from both the pull and a late push within ~2s, so it only
  navigates/toasts once.
- **ToastStack** — bottom-right stack of dismissible toasts (click or Enter/Space to
  dismiss, auto-dismiss after ~4.5s). Types: `success` (green accent — "Added to library:
  <name>"), `info` (blue accent), `error` (red/danger accent — e.g. a magnet link or
  .torrent file that failed to add).
- **EmptyState** — three variants: `library` (welcoming import/add-torrent CTAs),
  `no-results` (search/filter yielded nothing), `downloads` (no active/finished torrents).
- **NoElectronNotice** — full-screen friendly notice shown when `window.api` is undefined
  (i.e. running the renderer outside the Electron shell).
- **icons.jsx** — small inline-SVG icon set (no icon library dependency): library, download,
  plus, dots, play/pause, prev/next track, rewind/fast-forward (used with a small "30" badge
  for the ±30s skip buttons), volume, close, check, search, trash, chapters (list with
  bullet dots), gear (settings).

## Interaction patterns
- **Hover-to-reveal actions**: genre row `⋯` and book card play overlay only appear on
  hover/focus, keeping list/grid views visually calm at rest.
- **Destructive actions always confirm**: removing a book, deleting a genre, and removing a
  torrent all go through `ConfirmDialog`; file-deletion is opt-in via a checkbox, never
  implied by the primary action.
- **Suggestions are never silently applied**: `suggestedGenre` only ever renders as a
  dismissible pill; accepting it creates the genre (case-insensitive match against existing
  genres first) and assigns it, rejecting just clears the suggestion.
- **Keyboard**: Space toggles play/pause whenever a book is loaded, unless focus is inside an
  `input`/`textarea`/`select`/content-editable element. Escape closes open menus and dialogs
  and cancels inline genre editing.
- **Focus visibility**: global `:focus-visible` ring in accent color on every interactive
  element; the toolbar search field instead shows an accent border + soft glow (keeps the
  pill-shaped input tidy while remaining clearly focused).
- **Live data**: library list refetches on the `library:changed` event; torrent list is
  driven by `torrents:progress` push events (with an initial `torrents:list` fetch on
  mount); a toast fires on `torrents:done`.
- **In-session playback resume cache**: `playerSavePosition` doesn't trigger a
  `library:changed` broadcast, so the library list's `book.position` can lag behind what was
  actually just saved. `PlayerContext` keeps its own `bookId -> {fileIndex, seconds}` cache
  that's updated on every save (periodic, pause, file switch, close) and always takes
  priority over the fetched `book.position` when resuming — the freshest in-session value
  wins. If the currently-playing book disappears from the library (e.g. removed), playback
  stops automatically rather than continuing to save against a book that no longer exists.
- **Chapter highlighting**: the active chapter is the last one (in list order) at or before
  the current file/time — i.e. for embedded chapters, the last `startSec <= currentTime`
  within the current file; for derived (per-file) chapters this simplifies to "the chapter
  for the current file". Jumping to a chapter reuses the same `persistPosition` path as
  every other seek/switch, so it never bypasses position saving.
- **Drag & drop import**: dragging files/folders over the window shows a full-window overlay;
  dropping resolves paths via `getPathForFile` and calls `libraryImportPaths`. Drags are only
  recognized when `dataTransfer.types` includes `'Files'` — this is what distinguishes an
  actual OS file drag from an in-app drag (e.g. dragging selected text out of an input),
  which never carries a `'Files'` type. A dragenter/dragleave depth counter avoids the
  overlay flickering as the drag crosses child element boundaries.
- **Import never runs twice concurrently**: both import entry points (drag & drop, and the
  toolbar/empty-state "Import books…" button) track their own busy flag and ignore
  re-triggering while an import is in flight, since folder scans can take a while and a
  second concurrent import would create duplicate books. The button-based path additionally
  disables the button and swaps its label to "Importing…"; the drop path shows the busy
  overlay described above.
- **Incoming magnet -> navigate to Downloads**: the app can be set as the OS's default
  handler for `magnet:` links (Settings -> Magnet links). When one arrives from outside the
  app, `MagnetNavigator` doesn't touch the torrent (main already added it) — it only flips
  the active view to Downloads and shows a toast, so the user always lands where the new
  download is visible instead of wondering whether anything happened.
- **Safety-report toasts scale with severity, not with noise**: on `onSafetyReport`,
  `danger` gets a prominent, longer-lived (9s) error toast naming the worst offending file
  ("⛔ Blocked a suspicious file in "<name>": <file> — downloaded audio only."); `caution`
  gets a shorter (6s) subtle info toast with just a count ("⚠ Skipped N non-audio files in
  "<name>"."); `clean` gets **no toast at all**, even though `skippedCount` can still be > 0
  (benign companion files — cover art, `.nfo`, subtitles — are always skipped silently and
  never counted toward these messages, only archives/executables/disguised/unrecognized
  files are "noteworthy"). If no audio was found in the torrent at all, both toast variants
  append "No audio was found — nothing was downloaded." instead of "Downloaded audio only."
  so the toast alone conveys the outcome even before the user looks at the row.
- **VirusTotal (`VirusTotalContext`): "unknown" is never good news, quiet progress, loud
  infection**. On `onScanComplete`, only `infected` (12s error toast, naming the worst file
  when known) and `suspicious` (7s info toast) produce a toast; `clean` **and** `unknown`
  both stay silent — an `unknown` result is not reassuring (VT simply has no record of the
  file) and must never be communicated the way a "clean" result would be, including through
  toast presence/absence. `onScanProgress` never toasts at all (badge-only, see `ScanBadge`
  above) to avoid spamming a large library scanning slowly in the background under the free
  tier's rate limit. An infected book's toast intentionally does **not** embed a "Remove"
  button — `ToastStack` stays a simple message+dismiss surface; the actual remove action
  lives as a persistent, always-visible control on the book's card (see `BookCard`), which
  doesn't disappear the way a toast does. `VirusTotalContext` keeps an in-session
  `scanOverrides` cache (bookId -> latest result) exactly like `TorrentsContext`'s
  `safetyReports` / `PlayerContext`'s position cache, so the badge/alert update immediately
  on `onScanComplete` without waiting on a full library refetch.
- **Never imply VirusTotal runs before or during download**: every honest-disclosure surface
  (Settings caption, this file) states scanning happens strictly *after* a book finishes
  downloading, using hashes of files already on disk — VT is structurally incapable of
  seeing anything earlier, since hash identity requires complete file content.

## Naming conventions
- Components: PascalCase files under `components/`, one component per file.
- Context/state: `context/XxxContext.jsx` exporting `XxxProvider` + `useXxx()` hook.
- Utilities: plain functions in `utils/` (`format.js` time/size formatting, `media.js`
  `media://` URL builder, `color.js` placeholder gradient/initials).
- CSS: one file per concern under `styles/`, all imported through `styles/index.css`;
  class names are kebab-case and largely BEM-ish scoped by component
  (e.g. `.book-card`, `.book-cover`, `.book-play-overlay`).

## Known assumptions (see report for full list)
- "Add torrent" in the Library toolbar navigates to the Downloads view rather than opening
  a second magnet-input UI in place.
- Settings view only surfaces `downloadDir` (via `settingsGet` / `settingsChooseDownloadDir`);
  no other settings are exposed since none were specified.
- Coded against `libraryImportPaths(paths)`, `settingsChooseDownloadDir()`, and
  `getPathForFile(file)` per docs/PLAN2.md ahead of the backend landing them — every call
  site is optional-chained (`api?.libraryImportPaths?.(...)`, etc.) so the renderer degrades
  silently (no crash, no-op) until those land.
- Coded against `systemSetDefaultMagnetHandler()`, `systemIsDefaultMagnetHandler()`,
  `onMagnetReceived(cb)`, and `systemConsumePendingMagnet()` (the last is the pull-based
  cold-start complement to `onMagnetReceived`, returning `{ magnet }` / `{ magnet, error }` /
  `null`) per docs/PLAN3.md, same ahead-of-backend optional-chaining pattern. The "Make
  default" button is disabled and the status reads "Checking…"/stays unresolved until
  `systemIsDefaultMagnetHandler` exists; `MagnetNavigator`'s cold-start pull is simply a
  no-op until `systemConsumePendingMagnet` exists.
- The "Default magnet handler" UI lives in its own "Magnet links" settings-section card
  (rather than as a second row inside "Downloads") since it's conceptually an OS-integration
  setting, not a download setting — still directly below the Downloads card as specified.
- Coded against `torrent.safety: { verdict, hasAudio, skippedCount } | null` (on
  `torrents:list`/`torrents:progress` items) and `onSafetyReport(cb)` (event payload
  `{ infoHash, name, verdict, hasAudio, downloadedCount, skipped }`) per docs/PLAN4.md ahead
  of the backend landing them. `SafetyBadge` is gated on `'safety' in torrent` rather than
  truthiness, so it's simply not rendered at all (not stuck "Checking…") until a backend that
  sets the field — even as `null` — is running; `onSafetyReport` is optional-chained the same
  way as every other event subscription.
- Per-file skip detail (name/category/reason) is only ever delivered via the `onSafetyReport`
  event, never via `torrents:list` (which only has the `skippedCount` summary) — so
  `TorrentsContext` caches the last report per `infoHash` in memory for `SafetyDetails` to
  read. If a torrent has `skippedCount > 0` but the app hasn't received an event for it this
  session (e.g. right after startup, before any restore-time re-broadcast), the details
  popover shows a "re-add to see specifics" fallback rather than fabricating data.
- Coded against `virusTotalGetSettings()` -> `{enabled, hasKey}`, `virusTotalSetKey(key)` ->
  `{ok, valid, reason}`, `virusTotalScanBook(bookId)` -> `{queued}`, `onScanProgress(cb)` ->
  `{bookId, done, total}`, `onScanComplete(cb)` -> `{bookId, verdict, infectedFiles}`, and
  `book.scan` per docs/PLAN4B.md, ahead of the backend landing them (same optional-chaining
  pattern as every other not-yet-shipped IPC surface in this app). Two call sites interpret
  the contract where it wasn't fully spelled out: (1) `setKey`'s `{ok, valid, reason}` is
  treated as "saved" only when both `ok` and `valid` are true — any other combination shows
  `reason` (or a fallback message) as an error toast and leaves the key field populated so
  the user can correct it; (2) since `onScanComplete`'s payload has no book title (only
  `bookId`), `VirusTotalContext` resolves the title by looking the id up in
  `LibraryContext`'s `books` for the toast copy.
- The infected-file toast intentionally does not embed an inline "remove" action (see
  Interaction patterns) — `ToastStack`/`ToastContext` weren't extended to support action
  buttons for this. If a future feature needs that, it's a deliberate, separate change to
  the shared toast primitive rather than a one-off for this feature.
- No "reveal in file manager" action was implemented for infected files — PLAN4B mentions it
  as a possible action, but the IPC contract provided for this pass only covers
  `virusTotalGetSettings`/`setKey`/`scanBook`/`onScanProgress`/`onScanComplete`, with no
  reveal-in-file-manager method. "Remove book" (reusing the existing delete-files-aware
  confirm flow) is implemented; flag if a reveal action should be added once/if a
  corresponding IPC method exists.
