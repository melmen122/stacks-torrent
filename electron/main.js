// electron/main.js
//
// App lifecycle, window creation, the `media://` protocol, and IPC channel
// registration. See docs/PLAN.md for the exact IPC contract this must match.

import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createLibraryStore } from './lib/library.js'
import { createTorrentManager } from './lib/torrents.js'
import { scanBookFiles, isExternalCoverName, ALLOWED_AUDIO_EXTENSIONS } from './lib/metadata.js'
import { groupImportPaths } from './lib/importGrouping.js'
import { parseRange } from './lib/mediaRange.js'
import { resolveMediaAccess } from './lib/mediaGate.js'
import { mimeTypeFor } from './lib/mimeTypes.js'
import { createPhoneServer } from './lib/phoneServer.js'
import { isMagnetUri, parseMagnetFromArgv } from './lib/magnetLink.js'
import { validateApiKey } from './lib/virusTotal.js'
import { buildImportSource } from './lib/bookSource.js'
import { createVirusTotalScanner } from './lib/virusTotalScanner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Single-instance lock — must run before any other app init (docs/PLAN3.md).
// If another instance already holds the lock, quit immediately; that primary
// instance receives this launch's magnet (if any) via 'second-instance'
// below, so nothing is lost by quitting here.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // `focusMainWindow`, `handleIncomingMagnet`, `registerAsDefaultMagnetHandler`,
  // and `bootstrap` are all hoisted `function` declarations defined later in
  // this file — safe to reference here regardless of textual order.

  // Second instance (all OSes): the OS/user attempted to launch a new copy
  // (e.g. by clicking another magnet: link) — focus the existing window and
  // check its argv for a magnet.
  app.on('second-instance', (event, argv) => {
    focusMainWindow()
    const magnet = parseMagnetFromArgv(argv)
    if (magnet) handleIncomingMagnet(magnet)
  })

  // macOS: registered EARLY (can fire before 'ready') so a cold launch by
  // clicking a magnet: link — the app itself wasn't running yet — is never
  // missed. `handleIncomingMagnet` queues if `torrentManager` isn't ready yet.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleIncomingMagnet(url)
  })

  registerAsDefaultMagnetHandler()

  // Windows/Linux: launching the app via a magnet: link delivers it as a
  // plain argv token on this (first) launch — there's no 'open-url' event
  // outside macOS. `second-instance` (above) covers subsequent launches
  // while already running.
  const argvMagnet = parseMagnetFromArgv(process.argv)
  if (argvMagnet) handleIncomingMagnet(argvMagnet)

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] failed to start:', err)
    app.quit()
  })
}

// Must be registered before `app` is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow = null
let library = null
let torrentManager = null
let settingsCache = null
let virusTotalScanner = null
let phoneServer = null

let userDataDir = ''
let libraryFilePath = ''
let coversDir = ''
let settingsFilePath = ''
let defaultDownloadDir = ''
let torrentsFilePath = ''
let torrentFilesDir = ''
let vtCacheFilePath = ''

function getWindow() {
  return mainWindow
}

function broadcastLibraryChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('library:changed')
  }
}

function broadcastPhoneStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('phone:status-changed', status)
  }
}

// ---------------------------------------------------------------------------
// Settings (userData/settings.json)
// ---------------------------------------------------------------------------

// docs/PLAN4B.md: disabled by default, enabled only once a valid key is set
// (see `virusTotal:setKey`). Never logged, never sent to the renderer as
// itself — only `hasKey`/`enabled` booleans ever cross the IPC boundary
// (see `virusTotal:getSettings`).
const DEFAULT_SETTINGS = {
  virusTotalEnabled: false,
  virusTotalApiKey: null,
  // Phone server (listen from an iPhone/iPad on the LAN/Tailscale — see
  // electron/lib/phoneServer.js). PIN + secret are generated lazily the
  // first time the server is enabled, then persisted so sessions survive an
  // app restart.
  phoneServerEnabled: false,
  phoneServerPort: 8787,
  phoneServerPin: null,
  phoneServerSecret: null
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath, 'utf-8')
    const parsed = JSON.parse(raw)
    settingsCache = { downloadDir: defaultDownloadDir, ...DEFAULT_SETTINGS, ...parsed }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[settings] failed to read settings.json:', err)
    settingsCache = { downloadDir: defaultDownloadDir, ...DEFAULT_SETTINGS }
  }
  return settingsCache
}

async function saveSettings(patch) {
  settingsCache = { ...settingsCache, ...patch }
  await fs.mkdir(userDataDir, { recursive: true })
  const tmpPath = path.join(userDataDir, `.settings.json.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmpPath, JSON.stringify(settingsCache, null, 2), 'utf-8')
  await fs.rename(tmpPath, settingsFilePath)
  return settingsCache
}

/**
 * Every settings object handed back to the renderer over IPC MUST go
 * through this first — `virusTotalApiKey` (docs/PLAN4B.md) is never
 * readable by the renderer through any channel except the dedicated
 * `virusTotal:getSettings` (booleans only, never the key itself).
 */
function stripSecretSettings(settings) {
  // `phoneServerSecret` (the HMAC key sessions are derived from) must never
  // reach the renderer via the generic settings channel — only via the
  // dedicated `phone:getStatus`, and even there only `pin`/`port`/etc, never
  // the secret itself. The PIN itself is fine to strip here too since the
  // desktop UI reads it from `phone:getStatus`, not `settings:get`.
  const { virusTotalApiKey, phoneServerSecret, phoneServerPin, ...safeSettings } = settings ?? {}
  return safeSettings
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

function generateBookId() {
  return `b${crypto.randomBytes(8).toString('hex')}`
}

const AUDIO_DIALOG_FILTERS = [
  { name: 'Audio files', extensions: ALLOWED_AUDIO_EXTENSIONS.map((e) => e.slice(1)) }
]

/**
 * Prompt the user to pick a folder and/or individual audio files to import.
 *
 * macOS's native open dialog can present a single picker that allows
 * choosing both files and folders together. Windows and Linux cannot combine
 * `openFile` + `openDirectory` in one dialog (Electron falls back to a
 * directory-only picker there), which would silently make loose-file import
 * impossible — so on those platforms we first ask Folder vs Files via a
 * message box, then show the matching single-purpose dialog. The renderer
 * passes no arguments to `library:import`, so this choice is made entirely
 * on the backend.
 */
async function pickImportPaths(win) {
  if (process.platform === 'darwin') {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import audiobook files or folder',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: AUDIO_DIALOG_FILTERS
    })
    return result.canceled ? [] : result.filePaths
  }

  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Import Audiobook',
    message: 'Import a whole folder, or select individual audio files?',
    buttons: ['Folder', 'Files', 'Cancel'],
    defaultId: 0,
    cancelId: 2
  })
  if (choice.response === 2) return []

  const properties = choice.response === 0 ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  const result = await dialog.showOpenDialog(win, {
    title: 'Import audiobook files or folder',
    properties,
    filters: AUDIO_DIALOG_FILTERS
  })
  return result.canceled ? [] : result.filePaths
}

async function listCoverCandidates(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && isExternalCoverName(e.name))
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/**
 * Scan and add each already-grouped set of files (see importGrouping.js) as
 * a book. Shared by both `library:import` (native dialog) and
 * `library:importPaths` (drag & drop).
 */
async function importGroupsToBooks(groups) {
  const addedBooks = []
  for (const group of groups) {
    const bookId = generateBookId()
    const coverCandidates = await listCoverCandidates(group.coverDir)
    const scanned = await scanBookFiles(group.files, {
      bookId,
      coversDir,
      folderName: group.folderName,
      extraCoverCandidates: coverCandidates
    })
    if (!scanned.files.length) continue
    // Provenance (docs/models.md's `Book.source`): the user supplied these
    // files directly — no torrent manifest was classified, so no safety
    // verdict is invented for them. `type: 'import'` still distinguishes
    // this from a legacy book with no `source` at all (added before this
    // field existed) — the renderer can tell "known import, no verdict"
    // apart from "unknown provenance".
    const book = await library.addBook({ id: bookId, ...scanned, source: buildImportSource() })
    addedBooks.push(book)
  }
  return addedBooks
}

// ---------------------------------------------------------------------------
// media:// protocol — serves only allowed audio files + the covers dir.
// ---------------------------------------------------------------------------

function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'file') return new Response('Not found', { status: 404 })

      const encodedPath = url.pathname.replace(/^\/+/, '')
      if (!encodedPath) return new Response('Not found', { status: 404 })

      const filePath = decodeURIComponent(encodedPath)
      const { allowed, resolvedPath, ext } = resolveMediaAccess(filePath, coversDir)
      if (!allowed) return new Response('Forbidden', { status: 403 })

      const stat = await fs.stat(resolvedPath).catch(() => null)
      if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 })

      const mimeType = mimeTypeFor(ext)
      const rangeHeader = request.headers.get('range') ?? request.headers.get('Range')
      const range = parseRange(rangeHeader, stat.size)

      if (range?.unsatisfiable) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        })
      }

      if (range) {
        const { start, end } = range
        const stream = createReadStream(resolvedPath, { start, end })
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      const stream = createReadStream(resolvedPath)
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes'
        }
      })
    } catch (err) {
      console.error('[media protocol] error serving request:', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}

// ---------------------------------------------------------------------------
// System: magnet: link default-handler + incoming magnet handling.
// See docs/PLAN3.md.
// ---------------------------------------------------------------------------

/**
 * Registers this app as eligible to handle magnet: links at the OS level.
 *
 * On Windows/Linux this uses the registry and is sufficient by itself. On
 * macOS, the app must ALSO declare the scheme in its Info.plist (handled at
 * build time — electron-builder maps package.json's `build.protocols` to
 * `CFBundleURLTypes`) — and even then, macOS still requires the *user* to
 * confirm/choose Audiobook Library as the default the first time (the same
 * way switching any URL-scheme handler works); this call only makes the app
 * *eligible*, it cannot force the OS default on its own.
 *
 * @returns {boolean} whether the underlying registration call succeeded.
 */
function registerAsDefaultMagnetHandler() {
  if (process.defaultApp) {
    // Running under the bare `electron` binary (dev/unpackaged): without
    // passing the exec path + script path, the OS would register the
    // generic Electron binary itself rather than this app.
    if (process.argv.length < 2) return false
    return app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])])
  }
  return app.setAsDefaultProtocolClient('magnet')
}

// Magnets received before `torrentManager` AND `mainWindow` both exist —
// e.g. a cold start where the app was launched BY clicking a magnet: link —
// are queued here and flushed once `bootstrap()` finishes. Gated on this
// explicit flag (set true only after `createWindow()`) rather than just
// `torrentManager` truthiness: `torrentManager` is assigned partway through
// `bootstrap()`, well before `createWindow()` runs, so gating on it alone
// would let a magnet through in that window while `mainWindow` is still
// null, silently dropping the focus/`system:magnet-received` step below.
let appReadyForMagnets = false
const pendingMagnets = []

// Pull-model complement to the `system:magnet-received` push (see
// `processIncomingMagnet`): on a cold start, `did-finish-load` firing does
// NOT guarantee the renderer's React tree has mounted and its
// `onMagnetReceived` subscription (attached in a `useEffect`) has actually
// registered yet — that can lag behind page load, silently dropping the
// push. Every processed magnet is also remembered here; the renderer pulls
// via `system:consumePendingMagnet` on mount to catch anything the push
// missed. Capped defensively so a very long session can't grow this
// unboundedly if the renderer never happens to pull (e.g. only ever using
// the push path, which is the common/warm case).
const MAX_PENDING_CONSUMABLE_MAGNETS = 20
const pendingConsumableMagnets = []

function rememberPendingMagnet(payload) {
  pendingConsumableMagnets.push(payload)
  if (pendingConsumableMagnets.length > MAX_PENDING_CONSUMABLE_MAGNETS) {
    pendingConsumableMagnets.shift()
  }
}

/** Consumes (returns + removes) the oldest not-yet-pulled magnet, or null. */
function consumePendingMagnet() {
  return pendingConsumableMagnets.length ? pendingConsumableMagnets.shift() : null
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

const WINDOW_READY_TIMEOUT_MS = 10000

/**
 * Resolves once `mainWindow` exists and has finished its initial load (or
 * immediately, if it's already loaded/there's no window at all) — so the
 * `system:magnet-received` event sent right after has the best chance of
 * reaching an already-mounted renderer. Also resolves on `did-fail-load` or
 * after a timeout, so a page that never finishes loading can't hang the
 * flush loop (`flushPendingMagnets`) forever.
 */
function whenWindowReady() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve()
    if (!mainWindow.webContents.isLoading()) return resolve()

    let settled = false
    let timer = null
    const settle = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }

    mainWindow.webContents.once('did-finish-load', settle)
    mainWindow.webContents.once('did-fail-load', settle)
    timer = setTimeout(settle, WINDOW_READY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

async function processIncomingMagnet(magnet) {
  // Add failure (e.g. a malformed magnet) must not skip focusing the window
  // or leave the user with zero feedback — caught here so the focus/notify
  // steps below always run regardless of whether the add succeeded.
  let error = null
  try {
    // Reuses the exact same add path as the `torrents:add` IPC handler,
    // including its webtorrent-level duplicate-add dedupe (see torrents.js),
    // so re-clicking a magnet that's already downloading (or already
    // imported) just resolves instead of starting a second download/import.
    const settings = settingsCache ?? (await loadSettings())
    await torrentManager.add(magnet, settings.downloadDir)
  } catch (err) {
    console.error('[system] failed to add incoming magnet:', err)
    error = err?.message || 'Failed to add magnet link'
  }

  await whenWindowReady()
  focusMainWindow()

  const payload = error ? { magnet, error } : { magnet }
  // Remembered regardless of push delivery so the renderer's mount-time
  // pull (`system:consumePendingMagnet`) can always catch up; the renderer
  // is expected to dedupe by magnet string if both push and pull deliver
  // the same one (harmless — navigate-to-Downloads + toast is idempotent).
  rememberPendingMagnet(payload)

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('system:magnet-received', payload)
  }
}

/**
 * Single funnel for all three magnet entry points (macOS `open-url`,
 * Windows/Linux first-launch argv, `second-instance` argv). Ignores
 * anything that isn't a magnet: URI. Queues if the torrent manager isn't
 * ready yet and flushes once it is (see `pendingMagnets`/`flushPendingMagnets`).
 */
function handleIncomingMagnet(url) {
  if (!isMagnetUri(url)) return
  if (!appReadyForMagnets || !torrentManager) {
    pendingMagnets.push(url)
    return
  }
  processIncomingMagnet(url).catch((err) => {
    console.error('[system] failed to handle incoming magnet:', err)
  })
}

async function flushPendingMagnets() {
  const queued = pendingMagnets.splice(0, pendingMagnets.length)
  for (const magnet of queued) {
    try {
      await processIncomingMagnet(magnet)
    } catch (err) {
      console.error('[system] failed to handle queued incoming magnet:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpcHandlers() {
  ipcMain.handle('library:list', async () => library.list())

  ipcMain.handle('library:import', async () => {
    const win = getWindow()
    const filePaths = await pickImportPaths(win)
    if (!filePaths.length) return []

    const { groups } = await groupImportPaths(filePaths)
    const addedBooks = await importGroupsToBooks(groups)

    if (addedBooks.length) broadcastLibraryChanged()
    return addedBooks
  })

  ipcMain.handle('library:importPaths', async (event, paths) => {
    const validPaths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length > 0) : []
    if (!validPaths.length) return { added: [], skipped: [] }

    const { groups, skipped } = await groupImportPaths(validPaths)
    const addedBooks = await importGroupsToBooks(groups)

    if (addedBooks.length) broadcastLibraryChanged()
    return { added: addedBooks, skipped }
  })

  ipcMain.handle('library:setGenre', async (event, bookId, genreId) => {
    const book = await library.setGenre(bookId, genreId)
    broadcastLibraryChanged()
    return book
  })

  ipcMain.handle('library:removeBook', async (event, bookId, opts) => {
    const result = await library.removeBook(bookId, opts)
    broadcastLibraryChanged()
    return result
  })

  ipcMain.handle('genres:create', async (event, name) => {
    const genre = await library.createGenre(name)
    broadcastLibraryChanged()
    return genre
  })

  ipcMain.handle('genres:rename', async (event, id, name) => {
    const genre = await library.renameGenre(id, name)
    broadcastLibraryChanged()
    return genre
  })

  ipcMain.handle('genres:delete', async (event, id) => {
    const result = await library.deleteGenre(id)
    broadcastLibraryChanged()
    return result
  })

  ipcMain.handle('torrents:add', async (event, magnetUri) => {
    let torrentId = magnetUri
    if (!torrentId) {
      const win = getWindow()
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a .torrent file',
        properties: ['openFile'],
        filters: [{ name: 'Torrent files', extensions: ['torrent'] }]
      })
      if (result.canceled || !result.filePaths.length) return null
      torrentId = result.filePaths[0]
    }
    const settings = settingsCache ?? (await loadSettings())
    return torrentManager.add(torrentId, settings.downloadDir)
  })

  ipcMain.handle('torrents:list', async () => torrentManager.list())
  ipcMain.handle('torrents:pause', async (event, infoHash) => torrentManager.pause(infoHash))
  ipcMain.handle('torrents:resume', async (event, infoHash) => torrentManager.resume(infoHash))
  ipcMain.handle('torrents:remove', async (event, infoHash, opts) => torrentManager.remove(infoHash, opts))

  ipcMain.handle('player:savePosition', async (event, bookId, fileIndex, seconds) =>
    library.savePosition(bookId, fileIndex, seconds)
  )

  ipcMain.handle('settings:get', async () => {
    // This is the generic, pre-existing (docs/PLAN2.md) settings channel —
    // must never be a path the key reaches the renderer through; only
    // `virusTotal:getSettings` (booleans only) is.
    const settings = settingsCache ?? (await loadSettings())
    return stripSecretSettings(settings)
  })
  ipcMain.handle('settings:set', async (event, patch) => {
    // Defense in depth: the generic settings patch channel must never be a
    // side-door to set/clear the VirusTotal key or flip `virusTotalEnabled`
    // without going through `virusTotal:setKey`'s validation — strip both
    // before applying, regardless of what the caller sent. Same logic for
    // the phone-server secrets/PIN/port/enabled flag: `isAuthorized`/
    // `handleAuth` (electron/lib/phoneServer.js) read `getSettings()` live
    // per request, so setting these here would take effect instantly with
    // no restart and no UI trace, and would bypass `phone:setPort`'s
    // 1024-65535 validation entirely.
    const {
      virusTotalApiKey,
      virusTotalEnabled,
      phoneServerPin,
      phoneServerSecret,
      phoneServerPort,
      phoneServerEnabled,
      ...safePatch
    } = patch ?? {}
    const settings = await saveSettings(safePatch)
    return stripSecretSettings(settings)
  })

  ipcMain.handle('settings:chooseDownloadDir', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Download Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null

    const chosenDir = result.filePaths[0]
    await fs.mkdir(chosenDir, { recursive: true }).catch((err) => {
      console.error('[settings] failed to create chosen download dir:', err)
    })
    // Only affects new torrents going forward — existing ones keep the
    // downloadDir they were originally added with (persisted per-torrent in
    // torrents.json), unaffected by this change.
    const settings = await saveSettings({ downloadDir: chosenDir })
    return stripSecretSettings(settings)
  })

  ipcMain.handle('system:setDefaultMagnetHandler', async () => {
    const ok = registerAsDefaultMagnetHandler()
    const isDefault = app.isDefaultProtocolClient('magnet')
    return { ok, isDefault }
  })

  ipcMain.handle('system:isDefaultMagnetHandler', async () => app.isDefaultProtocolClient('magnet'))

  // Pull-model complement to the `system:magnet-received` push — see the
  // `pendingConsumableMagnets` comment above. Returns `{magnet}` (or
  // `{magnet, error}`) for the oldest not-yet-pulled magnet, clearing it in
  // the same call, or `null` if there's nothing pending.
  ipcMain.handle('system:consumePendingMagnet', async () => consumePendingMagnet())

  // docs/PLAN4B.md — the API key itself NEVER crosses this boundary in
  // either direction beyond `setKey`'s own input argument; `getSettings`
  // only ever returns booleans.
  ipcMain.handle('virusTotal:getSettings', async () => {
    const settings = settingsCache ?? (await loadSettings())
    return {
      enabled: !!settings.virusTotalEnabled && !!settings.virusTotalApiKey,
      hasKey: !!settings.virusTotalApiKey
    }
  })

  ipcMain.handle('virusTotal:setKey', async (event, key) => {
    if (!key) {
      await saveSettings({ virusTotalApiKey: null, virusTotalEnabled: false })
      return { ok: true, valid: false, reason: 'cleared' }
    }
    if (typeof key !== 'string') {
      return { ok: false, valid: false, reason: 'invalid-key' }
    }

    // Validated with ONE cheap real call (GET /users/<key>) before ever
    // persisting or enabling — never an EICAR/file-lookup style call, and
    // the key is never logged (see `validateApiKey`'s own contract).
    const { valid, reason } = await validateApiKey(key)
    if (!valid) {
      return { ok: false, valid: false, reason }
    }

    await saveSettings({ virusTotalApiKey: key, virusTotalEnabled: true })
    return { ok: true, valid: true, reason: null }
  })

  ipcMain.handle('virusTotal:scanBook', async (event, bookId) => {
    if (!virusTotalScanner) return { queued: false }
    return virusTotalScanner.scanBook(bookId)
  })

  // Phone server — listen from an iPhone/iPad on the LAN/Tailscale (see
  // electron/lib/phoneServer.js). `pin` IS included here (unlike
  // `settings:get`/`stripSecretSettings`) — the desktop Settings UI needs to
  // display it so the user can type it into their phone.
  ipcMain.handle('phone:getStatus', async () => phoneServer.getStatus())

  ipcMain.handle('phone:setEnabled', async (event, enabled) => {
    await saveSettings({ phoneServerEnabled: !!enabled })
    if (enabled) {
      await phoneServer.start()
    } else {
      await phoneServer.stop()
    }
    return phoneServer.getStatus()
  })

  ipcMain.handle('phone:setPort', async (event, port) => {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      // Renderer already validates this client-side (SettingsView.jsx), but
      // a direct/malformed IPC call can still reach here. Resolve with the
      // same `getStatus()`-shaped value every other phone:* handler
      // resolves with (rather than throwing) so the renderer's normal
      // `status?.error` display path handles it — a thrown Error here gets
      // wrapped by Electron into "Error invoking remote method 'phone:
      // setPort': Error: ...", which the renderer's catch-fallback then
      // shows verbatim as a toast.
      return { ...phoneServer.getStatus(), error: 'invalid_port' }
    }
    await saveSettings({ phoneServerPort: parsed })
    // Guard on "enabled", not "running": after a failed bind (e.g.
    // EADDRINUSE) `getStatus().running` is false, so gating the restart on
    // it made changing the port a dead end — the server just stayed down
    // with the stale error forever, even though the user just fixed it.
    if (settingsCache.phoneServerEnabled) await phoneServer.restart()
    return phoneServer.getStatus()
  })

  ipcMain.handle('phone:regeneratePin', async () => {
    // A fresh secret means every previously-issued session cookie's
    // HMAC(secret, pin) stops matching — regenerating always invalidates
    // existing phone sessions, whether or not the PIN string happens to
    // repeat.
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const secret = crypto.randomBytes(32).toString('hex')
    await saveSettings({ phoneServerPin: pin, phoneServerSecret: secret })
    const status = phoneServer.getStatus()
    // Unlike start/stop/restart (which go through phoneServer.js's own
    // notifyStatus()), this handler mutates settings directly — without this,
    // only the invoking window's IPC response saw the new PIN and any other
    // already-open window (or the same window's own status listener) stayed
    // on the stale one until the next unrelated status change.
    broadcastPhoneStatus(status)
    return status
  })
}

// ---------------------------------------------------------------------------
// Window + lifecycle
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Keyed solely off this env var (set only by `npm run dev` via
  // scripts/start-dev.cjs) rather than `!app.isPackaged` — `npm start`
  // (`electron .`) runs unpackaged too, so an `!app.isPackaged` check would
  // make it try to load a dead http://localhost:5173 instead of the built
  // dist/index.html whenever the Vite dev server isn't running.
  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap() {
  userDataDir = app.getPath('userData')
  libraryFilePath = path.join(userDataDir, 'library.json')
  coversDir = path.join(userDataDir, 'covers')
  settingsFilePath = path.join(userDataDir, 'settings.json')
  defaultDownloadDir = path.join(userDataDir, 'downloads')
  torrentsFilePath = path.join(userDataDir, 'torrents.json')
  torrentFilesDir = path.join(userDataDir, 'torrents')
  vtCacheFilePath = path.join(userDataDir, 'vt-cache.json')

  await fs.mkdir(coversDir, { recursive: true })

  library = createLibraryStore(libraryFilePath)
  await library.load()

  await loadSettings()
  await fs.mkdir(settingsCache.downloadDir, { recursive: true }).catch((err) => {
    console.error('[main] failed to create download dir:', err)
  })

  virusTotalScanner = createVirusTotalScanner({
    library,
    getWindow,
    getSettings: () => settingsCache,
    cacheFilePath: vtCacheFilePath
  })

  torrentManager = createTorrentManager({
    library,
    coversDir,
    getWindow,
    torrentsFilePath,
    torrentFilesDir,
    // docs/PLAN4B.md: "after handleDone imports a book, enqueue that book's
    // audio files for scanning if VT is enabled" — the enabled/key check
    // itself lives inside `scanBook`, so this is a no-op when VT isn't set up.
    onBookImported: (book) => {
      virusTotalScanner.scanBook(book.id).catch((err) => {
        console.error('[main] failed to enqueue newly-imported book for scanning:', err)
      })
    }
  })

  phoneServer = createPhoneServer({
    getLibrary: () => library,
    getSettings: () => settingsCache,
    saveSettings,
    onStatusChange: broadcastPhoneStatus
  })

  registerMediaProtocol()
  registerIpcHandlers()

  if (settingsCache.phoneServerEnabled) {
    await phoneServer.start()
  }

  // Re-add persisted, non-done torrents from a previous session. Runs
  // before any window exists — safe, since progress/done broadcasts inside
  // torrentManager already no-op whenever `getWindow()` returns null.
  await torrentManager.restorePersisted().catch((err) => {
    console.error('[main] failed to restore persisted torrents:', err)
  })

  createWindow()

  // Only now are both `torrentManager` and `mainWindow` guaranteed to
  // exist — flush any magnet(s) received before this point (e.g. a cold
  // start where the app was launched BY clicking a magnet: link), which
  // `handleIncomingMagnet` queued until now.
  appReadyForMagnets = true
  await flushPendingMagnets()

  // docs/PLAN4B.md: "on app start, enqueue books whose scan field is
  // missing/stale" — bounded naturally by the scanner's own sequential
  // book queue + shared rate-limited lookup queue; no-ops entirely if VT
  // isn't enabled/configured.
  virusTotalScanner.enqueueStaleBooks()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

let quitting = false

app.on('before-quit', (event) => {
  if (quitting || !torrentManager) return
  // Defer the actual quit until the torrent client (and its underlying
  // chunk-store file handles) has fully torn down, so the process can't
  // exit mid-write and truncate in-progress piece writes.
  event.preventDefault()
  quitting = true
  virusTotalScanner?.destroy()
  phoneServer?.stop().catch((err) => console.error('[main] error stopping phone server:', err))
  torrentManager
    .destroy()
    .catch((err) => console.error('[main] error destroying torrent client:', err))
    .finally(() => app.quit())
})
