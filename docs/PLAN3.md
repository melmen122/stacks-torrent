# Phase 3 — Make the app a magnet: handler

Goal: clicking a `magnet:` link (in a browser or anywhere) opens Audiobook Library and starts the download in our Downloads view, instead of uTorrent.

## Backend (electron/**, package.json)
- Single-instance lock: `app.requestSingleInstanceLock()`. If not acquired, `app.quit()` immediately (the primary instance receives the magnet via `second-instance`). Must run before other app init.
- Register handler on startup: `app.setAsDefaultProtocolClient('magnet')` (dev: also handle the argv form). Note in a comment that on macOS the OS still requires the user to confirm/choose the default; registration only makes the app *eligible*.
- Receiving a magnet, three entry points, all funnel into one `handleIncomingMagnet(url)`:
  - macOS: `app.on('open-url', (e, url) => { e.preventDefault(); handleIncomingMagnet(url) })` — register EARLY (can fire before `ready`).
  - Windows/Linux first launch: scan `process.argv` for a token starting `magnet:` during bootstrap.
  - Second instance (all OSes): `app.on('second-instance', (e, argv) => { focus window; scan argv for magnet })`.
- `handleIncomingMagnet(url)`: if `url` doesn't start with `magnet:`, ignore. Queue it if the window / torrent manager isn't ready yet; flush the queue once ready. When ready: call the existing torrent add path (same as `torrents:add`), then focus/show the window and send a new event `system:magnet-received` `{ magnet }` to the renderer so it can switch to Downloads + toast. Reuse the existing dedupe (duplicate magnet just resolves, no double book).
- New IPC:
  - `system:setDefaultMagnetHandler()` → calls `setAsDefaultProtocolClient('magnet')`, returns `{ ok, isDefault }` (isDefault via `isDefaultProtocolClient('magnet')`).
  - `system:isDefaultMagnetHandler()` → `boolean`.
  - Event: `system:magnet-received` → `{ magnet }`.
- Preload additions: `systemSetDefaultMagnetHandler()`, `systemIsDefaultMagnetHandler()`, `onMagnetReceived(cb)` (returns unsubscribe).
- Packaging (package.json `build`): add `protocols` so the installed app declares the scheme:
  ```json
  "protocols": [{ "name": "Magnet URI", "schemes": ["magnet"], "role": "Viewer" }]
  ```
  (electron-builder maps this to macOS `CFBundleURLTypes` and NSIS registry keys.)

## Frontend (src/renderer/**)
- Settings view: new row "Default magnet handler" — shows current status (call `systemIsDefaultMagnetHandler` on mount), a button "Make Audiobook Library the default"; on click call `systemSetDefaultMagnetHandler`, refresh status, toast success/failure, and a caption noting that on macOS you may still need to confirm in the browser/OS prompt the first time.
- Subscribe to `onMagnetReceived`: switch the active view to Downloads and toast "Magnet added — downloading…". (Torrent add already happened in main; this is just navigation + feedback. Guard `window.api` optional-chaining as elsewhere.)

## Out of scope
- Handling `.torrent` file double-click association (file, not URL scheme) — separate feature; note only.
- Auto-forcing uTorrent to relinquish default (OS-controlled; user does it once).
