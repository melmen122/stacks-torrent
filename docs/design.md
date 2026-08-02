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
  genre chip, `⋯` menu (assign genre — with a checkmark on the active one — or remove from
  library via `ConfirmDialog` with an "also delete files" checkbox).
- **LibraryView** — combines Toolbar + grid, computes filtered/sorted book list, and picks the
  right `EmptyState` variant (no books at all vs. no search results).
- **DownloadsView** — magnet-link form (input + Add + "Open .torrent file…") and a list of
  `TorrentRow`s.
- **TorrentRow** — name, progress bar, %, speed, peers, pause/resume (hidden once done),
  remove (with delete-files confirm). Completed torrents get a green-tinted border and a
  "Completed" label instead of live stats.
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
- **SettingsView** — sidebar nav entry below Downloads (gear icon). Two section cards:
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
