// electron/preload.cjs
//
// CommonJS on purpose — Electron preload scripts are loaded via a path that
// must resolve as CJS even though the rest of the app is ESM ("type":
// "module" in package.json). Exposes every IPC channel from docs/PLAN.md as
// a camelCase method on `window.api`, plus event subscriptions that return
// unsubscribe functions.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', {
  // Library
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryImport: () => ipcRenderer.invoke('library:import'),
  libraryImportPaths: (paths) => ipcRenderer.invoke('library:importPaths', paths),
  librarySetGenre: (bookId, genreId) => ipcRenderer.invoke('library:setGenre', bookId, genreId),
  libraryRemoveBook: (bookId, opts) => ipcRenderer.invoke('library:removeBook', bookId, opts),

  // Genres
  genresCreate: (name) => ipcRenderer.invoke('genres:create', name),
  genresRename: (id, name) => ipcRenderer.invoke('genres:rename', id, name),
  genresDelete: (id) => ipcRenderer.invoke('genres:delete', id),

  // Torrents
  torrentsAdd: (magnetUri) => ipcRenderer.invoke('torrents:add', magnetUri),
  torrentsList: () => ipcRenderer.invoke('torrents:list'),
  torrentsPause: (infoHash) => ipcRenderer.invoke('torrents:pause', infoHash),
  torrentsResume: (infoHash) => ipcRenderer.invoke('torrents:resume', infoHash),
  torrentsRemove: (infoHash, opts) => ipcRenderer.invoke('torrents:remove', infoHash, opts),

  // Player
  playerSavePosition: (bookId, fileIndex, seconds) =>
    ipcRenderer.invoke('player:savePosition', bookId, fileIndex, seconds),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  settingsChooseDownloadDir: () => ipcRenderer.invoke('settings:chooseDownloadDir'),

  // System: magnet: link default-handler (docs/PLAN3.md)
  systemSetDefaultMagnetHandler: () => ipcRenderer.invoke('system:setDefaultMagnetHandler'),
  systemIsDefaultMagnetHandler: () => ipcRenderer.invoke('system:isDefaultMagnetHandler'),
  // Pull-model catch-up for a magnet the `onMagnetReceived` push may have
  // missed (e.g. cold start, subscribed too late) — call on mount.
  systemConsumePendingMagnet: () => ipcRenderer.invoke('system:consumePendingMagnet'),

  // Drag & drop support: sandboxed renderers can't read `File.path` directly,
  // so dropped File objects are resolved to absolute paths via webUtils here.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Events (return an unsubscribe function)
  onTorrentsProgress: (callback) => subscribe('torrents:progress', callback),
  onTorrentsDone: (callback) => subscribe('torrents:done', callback),
  onLibraryChanged: (callback) => subscribe('library:changed', callback),
  onMagnetReceived: (callback) => subscribe('system:magnet-received', callback)
})
