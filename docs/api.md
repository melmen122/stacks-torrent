# IPC API Reference

The renderer communicates with Electron's main process via IPC (Inter-Process Communication). All methods are exposed on `window.api` (injected by `preload.cjs`) and are async.

## Library Management

### `libraryList()`
Fetch all books and genres in the library.

**Returns:**
```typescript
{
  books: Book[],
  genres: Genre[]
}
```

**Example:**
```javascript
const { books, genres } = await window.api.libraryList();
```

### `libraryImport()`
Open a native file/folder dialog and import audiobook files into the library. Scans metadata (title, author, genre, duration, cover art) from the files. One book per selected folder; loose files are grouped together.

**Returns:**
```typescript
Book[]  // Array of newly added books
```

**Example:**
```javascript
const imported = await window.api.libraryImport();
```

### `libraryImportPaths(paths)`
Import audiobooks from a list of absolute file/folder paths. Used by drag-and-drop import. Applies intelligent grouping rules:
- A directory with immediate audio file children → one book from that directory (recursive collection)
- A directory with no direct audio but subdirectories containing audio → one book per subdirectory
  - **Exception:** Disc-style layouts (subfolders named CD1/CD2, Disc 1, Disc 2, Part 1, Part 2, etc.) are recognized and merged into a single book with correct track ordering
- Loose audio files in the same call → grouped as one book

**Parameters:**
- `paths` (string[]) — Array of absolute file or folder paths

**Returns:**
```typescript
{
  added: Book[],        // Newly imported books
  skipped: string[]     // Paths with no audio files
}
```

**Example:**
```javascript
const { added, skipped } = await window.api.libraryImportPaths(['/path/to/audiobook/folder']);
```

### `librarySetGenre(bookId, genreId | null)`
Assign or remove a genre from a book. Also clears any suggested genre.

**Parameters:**
- `bookId` (string) — ID of the book
- `genreId` (string|null) — Genre ID to assign, or null to unassign

**Returns:**
```typescript
Book  // Updated book
```

**Example:**
```javascript
const updated = await window.api.librarySetGenre('b1', 'g1');
```

### `libraryRemoveBook(bookId, opts?)`
Remove a book from the library.

**Parameters:**
- `bookId` (string) — ID of the book
- `opts` (object, optional)
  - `deleteFiles` (boolean, default: false) — If true, also delete audio files and cover art

**Returns:**
```typescript
{ ok: true }
```

**Example:**
```javascript
await window.api.libraryRemoveBook('b1', { deleteFiles: true });
```

## Genre Management

### `genresCreate(name)`
Create a new genre.

**Parameters:**
- `name` (string) — Genre name

**Returns:**
```typescript
{ id: string, name: string }
```

**Example:**
```javascript
const genre = await window.api.genresCreate('Sci-Fi');
```

### `genresRename(id, name)`
Rename an existing genre.

**Parameters:**
- `id` (string) — Genre ID
- `name` (string) — New name

**Returns:**
```typescript
{ id: string, name: string }
```

**Example:**
```javascript
const updated = await window.api.genresRename('g1', 'Science Fiction');
```

### `genresDelete(id)`
Delete a genre. Books assigned to it become uncategorized.

**Parameters:**
- `id` (string) — Genre ID

**Returns:**
```typescript
{ ok: true }
```

**Example:**
```javascript
await window.api.genresDelete('g1');
```

## Torrent Management

### `torrentsAdd(magnetUri | null)`
Add a torrent by magnet URI or open a native dialog to select a `.torrent` file. The torrent begins downloading immediately to the configured download directory.

**Parameters:**
- `magnetUri` (string|null) — Magnet URI, or null to open file dialog

**Returns:**
```typescript
{
  infoHash: string,
  name: string,
  progress: number,        // 0–1
  downloadSpeed: number,   // bytes/second
  numPeers: number,
  done: boolean,
  paused: boolean
}
```

**Example:**
```javascript
const torrent = await window.api.torrentsAdd('magnet:?xt=urn:...');
// or:
const torrent = await window.api.torrentsAdd(null); // Opens dialog
```

### `torrentsList()`
List all active or completed torrents.

**Returns:**
```typescript
Array<{
  infoHash: string,
  name: string,
  progress: number,        // 0–1
  downloadSpeed: number,   // bytes/second
  numPeers: number,
  done: boolean,
  paused: boolean
}>
```

**Example:**
```javascript
const torrents = await window.api.torrentsList();
```

### `torrentsPause(infoHash)`
Pause a downloading torrent.

**Parameters:**
- `infoHash` (string) — The torrent's info hash

**Returns:**
```typescript
{
  infoHash: string,
  name: string,
  progress: number,        // 0–1
  downloadSpeed: number,   // bytes/second
  numPeers: number,
  done: boolean,
  paused: boolean
}
```

**Example:**
```javascript
const paused = await window.api.torrentsPause('abc123...');
```

### `torrentsResume(infoHash)`
Resume a paused torrent.

**Parameters:**
- `infoHash` (string) — The torrent's info hash

**Returns:**
```typescript
{
  infoHash: string,
  name: string,
  progress: number,        // 0–1
  downloadSpeed: number,   // bytes/second
  numPeers: number,
  done: boolean,
  paused: boolean
}
```

**Example:**
```javascript
const resumed = await window.api.torrentsResume('abc123...');
```

### `torrentsRemove(infoHash, opts?)`
Remove a torrent from the client. Downloaded files can optionally be deleted.

**Parameters:**
- `infoHash` (string) — The torrent's info hash
- `opts` (object, optional)
  - `deleteFiles` (boolean, default: false) — If true, delete downloaded files

**Returns:**
```typescript
// (no return value; check via torrentsList)
```

**Example:**
```javascript
await window.api.torrentsRemove('abc123...', { deleteFiles: true });
```

## Player

### `playerSavePosition(bookId, fileIndex, seconds)`
Save the current playback position for a book. Called periodically during playback, on pause, and when switching files.

**Parameters:**
- `bookId` (string) — Book ID
- `fileIndex` (number) — Index in the book's files array
- `seconds` (number) — Elapsed time in seconds

**Returns:**
```typescript
{ ok: true }
```

**Example:**
```javascript
await window.api.playerSavePosition('b1', 0, 1234);
```

## Settings

### `settingsGet()`
Retrieve all settings.

**Returns:**
```typescript
{
  downloadDir: string   // Absolute path where torrents download
}
```

**Example:**
```javascript
const settings = await window.api.settingsGet();
console.log(settings.downloadDir);
```

### `settingsSet(patch)`
Update settings. Only provided keys are changed.

**Parameters:**
- `patch` (object)
  - `downloadDir` (string, optional)

**Returns:**
```typescript
{
  downloadDir: string
}
```

**Example:**
```javascript
const updated = await window.api.settingsSet({ downloadDir: '/path/to/downloads' });
```

### `settingsChooseDownloadDir()`
Open a native folder picker to change the download directory. Persists the new setting immediately. Existing or in-progress torrents keep their original download location.

**Returns:**
```typescript
{
  downloadDir: string
} | null  // null if the user cancels
```

**Example:**
```javascript
const updated = await window.api.settingsChooseDownloadDir();
if (updated) {
  console.log('New download directory:', updated.downloadDir);
} else {
  console.log('User cancelled folder picker');
}
```

## System

### `systemSetDefaultMagnetHandler()`
Register Audiobook Library as the default handler for `magnet:` links. On macOS, this calls `app.setAsDefaultProtocolClient('magnet')`. On Windows, this writes the registry key.

**Returns:**
```typescript
{
  ok: boolean,      // true if registration was successful
  isDefault: boolean // true if the app is now the default magnet handler
}
```

**Example:**
```javascript
const result = await window.api.systemSetDefaultMagnetHandler();
if (result.ok && result.isDefault) {
  console.log('Audiobook Library is now the default magnet handler');
}
```

### `systemIsDefaultMagnetHandler()`
Check whether Audiobook Library is currently the default handler for `magnet:` links.

**Returns:**
```typescript
boolean  // true if this app is the default magnet handler
```

**Example:**
```javascript
const isDefault = await window.api.systemIsDefaultMagnetHandler();
console.log('Is default:', isDefault);
```

### `systemConsumePendingMagnet()`
Pull-based complement to the `system:magnet-received` event. Used to catch magnet links that arrived before the renderer could subscribe to the event (e.g., on cold start when the OS launches the app by magnet click).

**Returns:**
```typescript
{
  magnet: string,
  error?: string
} | null  // null if no magnet is pending
```

**Example:**
```javascript
const pending = await window.api.systemConsumePendingMagnet();
if (pending) {
  if (pending.error) {
    console.error('Magnet error:', pending.error);
  } else {
    console.log('Magnet URI:', pending.magnet);
  }
}
```

## Preload Utilities

### `getPathForFile(file)`
Convert a `File` object (from drag-and-drop or file input) to an absolute path. Used internally by drag-and-drop import to resolve files for `libraryImportPaths()`. Wraps Electron's `webUtils.getPathForFile()`.

**Parameters:**
- `file` (File) — A File object from the DOM File API

**Returns:**
```typescript
string  // Absolute file path
```

**Example:**
```javascript
const input = document.querySelector('input[type=file]');
input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const path = await window.api.getPathForFile(file);
  console.log('Absolute path:', path);
});
```

### Magnet Link Preload Methods

Shortcuts to the System magnet handler IPC calls (see [System](#system) section for details):

- `systemSetDefaultMagnetHandler()` → same as `ipcRenderer.invoke('system:setDefaultMagnetHandler')`
- `systemIsDefaultMagnetHandler()` → same as `ipcRenderer.invoke('system:isDefaultMagnetHandler')`
- `systemConsumePendingMagnet()` → same as `ipcRenderer.invoke('system:consumePendingMagnet')`

## Events

Events are subscribed via `on*` methods that return an unsubscribe function.

### `onTorrentsProgress(callback)`
Fired ~1s when torrent list changes (new torrent added, progress updated, torrent completed or paused).

**Callback:**
```typescript
(torrents: Torrent[]) => void
```

**Example:**
```javascript
const unsubscribe = window.api.onTorrentsProgress((torrents) => {
  console.log('Torrents updated:', torrents);
});
// Later:
unsubscribe();
```

### `onTorrentsDone(callback)`
Fired when a torrent completes and is successfully auto-imported into the library.

**Callback:**
```typescript
({ infoHash: string, name: string, bookId: string }) => void
```

**Example:**
```javascript
window.api.onTorrentsDone(({ infoHash, name, bookId }) => {
  console.log(`Torrent "${name}" imported as book ${bookId}`);
});
```

### `onLibraryChanged(callback)`
Fired when the library changes (book added/removed, genre renamed, etc.).

**Callback:**
```typescript
() => void
```

**Example:**
```javascript
window.api.onLibraryChanged(() => {
  console.log('Library updated; refetch books/genres');
});
```

### `onMagnetReceived(callback)`
Fired when the main process receives a magnet link (OS "open with" on second-instance or macOS open-url event). The main process attempts to add the torrent automatically; this event is pushed to the renderer for UI feedback (navigate to Downloads, show toast).

**Callback:**
```typescript
(payload: {
  magnet: string,
  error?: string  // Present if adding the torrent failed
}) => void
```

**Note:** This is a push-based event. On cold start (app launch triggered by magnet click), the event may fire before the renderer subscribes. Use `systemConsumePendingMagnet()` to pull any missed magnets on mount.

**Example:**
```javascript
const unsubscribe = window.api.onMagnetReceived(({ magnet, error }) => {
  if (error) {
    console.error('Failed to add magnet:', error);
  } else {
    console.log('Magnet added:', magnet);
    // Switch to Downloads view and show success toast
  }
});
// Later:
unsubscribe();
```

## Media Protocol

The main process registers a `media://` protocol for serving audio files and cover images. URLs follow the pattern:

```
media://file/<urlencoded-absolute-path>
```

Supports HTTP range requests for streaming.

**Example:**
```javascript
// In an <audio> element:
<audio src="media://file//Users/name/audiobook/01.mp3" />

// For cover images:
<img src="media://file//Users/name/.config/audiobook-app/covers/b1.jpg" />
```

The protocol restricts access to:
- Audio files with extensions: `.mp3`, `.m4a`, `.m4b`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`
- All files in the covers directory

---

**Note:** All IPC methods are async and must be awaited.
