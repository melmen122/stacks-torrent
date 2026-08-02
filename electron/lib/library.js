// electron/lib/library.js
//
// Books + genres store, JSON persisted to <userData>/library.json.
// No dependency on `electron`'s `app` module — the caller (main.js) passes
// in the resolved file path, which keeps this module importable/testable
// without a running Electron app.

import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'

function emptyLibrary() {
  return { genres: [], books: [] }
}

function genId(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`
}

/**
 * Create a library store bound to a single library.json file on disk.
 * Call `load()` once at startup before using the other methods.
 */
export function createLibraryStore(libraryFilePath) {
  let state = emptyLibrary()

  async function load() {
    try {
      const raw = await fs.readFile(libraryFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      state = {
        genres: Array.isArray(parsed.genres) ? parsed.genres : [],
        books: Array.isArray(parsed.books) ? parsed.books : []
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      state = emptyLibrary()
      await save()
    }
    return state
  }

  async function save() {
    const dir = path.dirname(libraryFilePath)
    await fs.mkdir(dir, { recursive: true })
    const tmpPath = path.join(dir, `.library.json.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
    await fs.rename(tmpPath, libraryFilePath)
  }

  function list() {
    return { books: state.books, genres: state.genres }
  }

  function findBook(bookId) {
    return state.books.find((b) => b.id === bookId) ?? null
  }

  function findGenre(genreId) {
    return state.genres.find((g) => g.id === genreId) ?? null
  }

  /**
   * Add a fully-scanned book to the library.
   * `bookData` should already contain title/author/files/etc — see docs/PLAN.md
   * data model. `id` is optional; one is generated if omitted.
   */
  async function addBook(bookData) {
    const book = {
      id: bookData.id || genId('b'),
      title: bookData.title,
      author: bookData.author,
      files: bookData.files ?? [],
      coverPath: bookData.coverPath ?? null,
      durationSec: bookData.durationSec ?? null,
      genreId: bookData.genreId ?? null,
      suggestedGenre: bookData.suggestedGenre ?? null,
      addedAt: bookData.addedAt ?? Date.now(),
      position: bookData.position ?? { fileIndex: 0, seconds: 0 },
      // Backward-compatible/optional (docs/PLAN2.md): only ever populated for
      // single-file books where music-metadata could extract embedded
      // chapter markers; existing books without this field are untouched.
      chapters: bookData.chapters ?? null
    }
    state.books.push(book)
    await save()
    return book
  }

  async function setGenre(bookId, genreId) {
    const book = findBook(bookId)
    if (!book) throw new Error(`Book not found: ${bookId}`)
    book.genreId = genreId ?? null
    book.suggestedGenre = null
    await save()
    return book
  }

  async function removeBook(bookId, { deleteFiles = false } = {}) {
    const idx = state.books.findIndex((b) => b.id === bookId)
    if (idx === -1) return { ok: true }
    const [book] = state.books.splice(idx, 1)
    await save()
    if (deleteFiles) {
      await Promise.all((book.files ?? []).map((f) => fs.unlink(f).catch(() => {})))
      if (book.coverPath) await fs.unlink(book.coverPath).catch(() => {})

      // Best-effort cleanup: remove each file's containing directory if it's
      // now empty. Fails silently (e.g. ENOTEMPTY, ENOENT) otherwise — we
      // never recurse or force-delete a non-empty directory here. Torrent
      // client bookkeeping (removing the torrent itself) is a separate,
      // out-of-scope concern handled via the torrents:remove IPC channel.
      const parentDirs = new Set((book.files ?? []).map((f) => path.dirname(f)))
      await Promise.all([...parentDirs].map((dir) => fs.rmdir(dir).catch(() => {})))
    }
    return { ok: true }
  }

  async function createGenre(name) {
    const genre = { id: genId('g'), name }
    state.genres.push(genre)
    await save()
    return genre
  }

  async function renameGenre(id, name) {
    const genre = findGenre(id)
    if (!genre) throw new Error(`Genre not found: ${id}`)
    genre.name = name
    await save()
    return genre
  }

  async function deleteGenre(id) {
    state.genres = state.genres.filter((g) => g.id !== id)
    for (const book of state.books) {
      if (book.genreId === id) book.genreId = null
    }
    await save()
    return { ok: true }
  }

  async function savePosition(bookId, fileIndex, seconds) {
    const book = findBook(bookId)
    if (!book) throw new Error(`Book not found: ${bookId}`)
    book.position = { fileIndex, seconds }
    await save()
    return { ok: true }
  }

  return {
    load,
    save,
    list,
    findBook,
    findGenre,
    addBook,
    setGenre,
    removeBook,
    createGenre,
    renameGenre,
    deleteGenre,
    savePosition,
    getState: () => state
  }
}
