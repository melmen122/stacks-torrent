import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { createLibraryStore } from '../electron/lib/library.js'

let root
let libraryFile

async function freshStore() {
  const store = createLibraryStore(libraryFile)
  await store.load()
  return store
}

async function exists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-store-'))
  libraryFile = path.join(root, 'userData', 'library.json')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('createLibraryStore', () => {
  it('load() on a missing file yields an empty library and creates the file', async () => {
    const store = await freshStore()
    expect(store.list()).toEqual({ books: [], genres: [] })
    expect(await exists(libraryFile)).toBe(true)
  })

  it('persists books across store instances (round-trip)', async () => {
    const store = await freshStore()
    const book = await store.addBook({ title: 'Dune', author: 'Frank Herbert' })

    const store2 = await freshStore()
    const found = store2.findBook(book.id)
    expect(found).not.toBeNull()
    expect(found.title).toBe('Dune')
    expect(found.author).toBe('Frank Herbert')
  })

  it('addBook fills defaults: generated id, empty files, zero position, null genre', async () => {
    const store = await freshStore()
    const book = await store.addBook({ title: 'T', author: 'A' })
    expect(book.id).toMatch(/^b[0-9a-f]{16}$/)
    expect(book.files).toEqual([])
    expect(book.position).toEqual({ fileIndex: 0, seconds: 0 })
    expect(book.genreId).toBeNull()
    expect(book.coverPath).toBeNull()
    expect(book.chapters).toBeNull()
    // Backward-compatible/optional (source provenance): defaults to null
    // when the caller doesn't supply one, exactly like scan/chapters.
    expect(book.source).toBeNull()
  })

  describe('source (provenance) — additive field', () => {
    it('a book added with no `source` behaves exactly as before (null, not undefined, and JSON round-trips it as null)', async () => {
      const store = await freshStore()
      const book = await store.addBook({ title: 'T', author: 'A' })
      expect(book.source).toBeNull()

      const store2 = await freshStore()
      expect(store2.findBook(book.id).source).toBeNull()
    })

    it('a pre-existing library.json written before this field existed loads unaffected (no `source` key at all, not even null)', async () => {
      await fs.mkdir(path.dirname(libraryFile), { recursive: true })
      const legacyBook = {
        id: 'b-legacy',
        title: 'Old Book',
        author: 'A',
        files: [],
        coverPath: null,
        durationSec: null,
        genreId: null,
        suggestedGenre: null,
        addedAt: 1,
        position: { fileIndex: 0, seconds: 0 }
        // no `chapters`, no `scan`, no `source` — a book written by a
        // version of this app before any of those fields existed.
      }
      await fs.writeFile(libraryFile, JSON.stringify({ genres: [], books: [legacyBook] }), 'utf-8')

      const store = createLibraryStore(libraryFile)
      await store.load()
      const found = store.findBook('b-legacy')
      expect(found).not.toBeNull()
      expect(found.title).toBe('Old Book')
      // Loaded as-is (library.js's load() doesn't re-normalize existing
      // records through addBook's defaults) — this test pins that reading
      // an old record never throws and the record is otherwise unchanged;
      // `source` simply isn't present, same as `scan`/`chapters` today.
      expect('source' in found).toBe(false)
    })

    it('a torrent-provenance source round-trips through save/load intact', async () => {
      const store = await freshStore()
      const source = {
        type: 'torrent',
        infoHash: 'abc123',
        safety: { verdict: 'clean', hasAudio: true, skippedCount: 0, skipped: [] },
        importedAt: 1700000000000
      }
      const book = await store.addBook({ title: 'T', author: 'A', source })

      const store2 = await freshStore()
      expect(store2.findBook(book.id).source).toEqual(source)
    })

    it('an import-provenance source is distinguishable from a torrent-provenance source and from a legacy (null) book', async () => {
      const store = await freshStore()
      const torrentBook = await store.addBook({
        title: 'From torrent',
        author: 'A',
        source: {
          type: 'torrent',
          infoHash: 'deadbeef',
          safety: { verdict: 'clean', hasAudio: true, skippedCount: 0, skipped: [] },
          importedAt: 1
        }
      })
      const importedBook = await store.addBook({
        title: 'From drag & drop',
        author: 'A',
        source: { type: 'import', importedAt: 2 }
      })
      const legacyBook = await store.addBook({ title: 'No provenance', author: 'A' })

      expect(store.findBook(torrentBook.id).source.type).toBe('torrent')
      expect(store.findBook(torrentBook.id).source.safety.verdict).toBe('clean')
      expect(store.findBook(importedBook.id).source).toEqual({ type: 'import', importedAt: 2 })
      expect(store.findBook(importedBook.id).source.safety).toBeUndefined()
      expect(store.findBook(legacyBook.id).source).toBeNull()
    })

    it('removing the source torrent later does not touch the already-persisted book.source (historical record, not a live reference)', async () => {
      const store = await freshStore()
      const source = {
        type: 'torrent',
        infoHash: 'now-removed-torrent',
        safety: { verdict: 'caution', hasAudio: true, skippedCount: 2, skipped: [] },
        importedAt: 5
      }
      const book = await store.addBook({ title: 'T', author: 'A', source })
      // Nothing in library.js references the torrent client at all — the
      // book's `source` is plain persisted data, so simply never touching
      // it again (as a real torrent removal would) proves it survives.
      const store2 = await freshStore()
      expect(store2.findBook(book.id).source).toEqual(source)
    })
  })

  it('addBook keeps a caller-provided id', async () => {
    const store = await freshStore()
    const book = await store.addBook({ id: 'b-custom', title: 'T', author: 'A' })
    expect(book.id).toBe('b-custom')
    expect(store.findBook('b-custom')).toBe(book)
  })

  it('addBook does NOT dedupe on id — the caller must check findBook first (import idempotency contract)', async () => {
    // Actual store semantics: addBook always pushes. Idempotent import is
    // implemented by the caller checking findBook(id) before adding. This
    // test pins that contract: a duplicate-id add produces two entries and
    // findBook returns the first.
    const store = await freshStore()
    const first = await store.addBook({ id: 'b-dup', title: 'Original', author: 'A' })
    await store.addBook({ id: 'b-dup', title: 'Duplicate', author: 'A' })
    expect(store.list().books).toHaveLength(2)
    expect(store.findBook('b-dup')).toBe(first)
    expect(store.findBook('b-dup').title).toBe('Original')
  })

  it('findBook returns null for an unknown id', async () => {
    const store = await freshStore()
    expect(store.findBook('nope')).toBeNull()
  })

  it('setGenre assigns the genre and clears suggestedGenre', async () => {
    const store = await freshStore()
    const genre = await store.createGenre('Sci-Fi')
    const book = await store.addBook({
      title: 'T',
      author: 'A',
      suggestedGenre: 'Science Fiction'
    })
    expect(book.suggestedGenre).toBe('Science Fiction')

    const updated = await store.setGenre(book.id, genre.id)
    expect(updated.genreId).toBe(genre.id)
    expect(updated.suggestedGenre).toBeNull()
  })

  it('setGenre(bookId, null) un-assigns the genre and still clears suggestedGenre', async () => {
    const store = await freshStore()
    const book = await store.addBook({ title: 'T', author: 'A', suggestedGenre: 'Horror' })
    const updated = await store.setGenre(book.id, null)
    expect(updated.genreId).toBeNull()
    expect(updated.suggestedGenre).toBeNull()
  })

  it('setGenre throws a useful error for an unknown book', async () => {
    const store = await freshStore()
    await expect(store.setGenre('missing-id', 'g1')).rejects.toThrow('Book not found: missing-id')
  })

  it('createGenre / renameGenre round-trip and persist', async () => {
    const store = await freshStore()
    const genre = await store.createGenre('Fantsy')
    await store.renameGenre(genre.id, 'Fantasy')

    const store2 = await freshStore()
    expect(store2.findGenre(genre.id).name).toBe('Fantasy')
  })

  it('renameGenre throws for an unknown genre', async () => {
    const store = await freshStore()
    await expect(store.renameGenre('g-missing', 'X')).rejects.toThrow('Genre not found: g-missing')
  })

  it('deleteGenre removes the genre and nulls genreId only on affected books', async () => {
    const store = await freshStore()
    const keep = await store.createGenre('Keep')
    const drop = await store.createGenre('Drop')
    const affected = await store.addBook({ title: 'X', author: 'A', genreId: drop.id })
    const untouched = await store.addBook({ title: 'Y', author: 'A', genreId: keep.id })

    await store.deleteGenre(drop.id)
    expect(store.findGenre(drop.id)).toBeNull()
    expect(store.findGenre(keep.id)).not.toBeNull()
    expect(store.findBook(affected.id).genreId).toBeNull()
    expect(store.findBook(untouched.id).genreId).toBe(keep.id)
  })

  it('savePosition updates and persists playback position', async () => {
    const store = await freshStore()
    const book = await store.addBook({ title: 'T', author: 'A' })
    await store.savePosition(book.id, 3, 127.5)

    const store2 = await freshStore()
    expect(store2.findBook(book.id).position).toEqual({ fileIndex: 3, seconds: 127.5 })
  })

  it('savePosition throws for an unknown book', async () => {
    const store = await freshStore()
    await expect(store.savePosition('ghost', 0, 0)).rejects.toThrow('Book not found: ghost')
  })

  describe('removeBook', () => {
    it('removes the book from the store without touching files by default', async () => {
      const store = await freshStore()
      const audioDir = path.join(root, 'books', 'keepme')
      await fs.mkdir(audioDir, { recursive: true })
      const f1 = path.join(audioDir, '01.mp3')
      await fs.writeFile(f1, 'audio')
      const book = await store.addBook({ title: 'T', author: 'A', files: [f1] })

      const result = await store.removeBook(book.id)
      expect(result).toEqual({ ok: true })
      expect(store.findBook(book.id)).toBeNull()
      expect(await exists(f1)).toBe(true)
    })

    it('with deleteFiles unlinks files + cover and prunes the now-empty dir', async () => {
      const store = await freshStore()
      const audioDir = path.join(root, 'books', 'gone')
      await fs.mkdir(audioDir, { recursive: true })
      const f1 = path.join(audioDir, '01.mp3')
      const f2 = path.join(audioDir, '02.mp3')
      const cover = path.join(root, 'covers-store', 'b1.jpg')
      await fs.mkdir(path.dirname(cover), { recursive: true })
      await Promise.all([fs.writeFile(f1, 'a'), fs.writeFile(f2, 'b'), fs.writeFile(cover, 'img')])
      const book = await store.addBook({
        title: 'T',
        author: 'A',
        files: [f1, f2],
        coverPath: cover
      })

      await store.removeBook(book.id, { deleteFiles: true })
      expect(await exists(f1)).toBe(false)
      expect(await exists(f2)).toBe(false)
      expect(await exists(cover)).toBe(false)
      expect(await exists(audioDir)).toBe(false)
    })

    it('with deleteFiles leaves a non-empty containing dir in place', async () => {
      const store = await freshStore()
      const audioDir = path.join(root, 'books', 'shared')
      await fs.mkdir(audioDir, { recursive: true })
      const f1 = path.join(audioDir, '01.mp3')
      const other = path.join(audioDir, 'unrelated.txt')
      await Promise.all([fs.writeFile(f1, 'a'), fs.writeFile(other, 'keep')])
      const book = await store.addBook({ title: 'T', author: 'A', files: [f1] })

      await store.removeBook(book.id, { deleteFiles: true })
      expect(await exists(f1)).toBe(false)
      expect(await exists(other)).toBe(true)
      expect(await exists(audioDir)).toBe(true)
    })

    it('is a no-op ok result for an unknown book id', async () => {
      const store = await freshStore()
      expect(await store.removeBook('never-existed')).toEqual({ ok: true })
    })

    it('with deleteFiles succeeds even when the files are already gone', async () => {
      const store = await freshStore()
      const ghost = path.join(root, 'books', 'ghost', '01.mp3')
      const book = await store.addBook({ title: 'T', author: 'A', files: [ghost] })
      const result = await store.removeBook(book.id, { deleteFiles: true })
      expect(result).toEqual({ ok: true })
      expect(store.findBook(book.id)).toBeNull()
    })
  })

  it('save() leaves no .tmp files behind (atomic write)', async () => {
    const store = await freshStore()
    await store.addBook({ title: 'T', author: 'A' })
    await store.createGenre('G')
    const leftovers = (await fs.readdir(path.dirname(libraryFile))).filter(
      (n) => n !== 'library.json'
    )
    expect(leftovers).toEqual([])
  })

  it('load() throws (rather than silently wiping) on corrupt JSON', async () => {
    await fs.mkdir(path.dirname(libraryFile), { recursive: true })
    await fs.writeFile(libraryFile, 'not json at all', 'utf-8')
    const store = createLibraryStore(libraryFile)
    await expect(store.load()).rejects.toThrow()
  })

  it('load() tolerates a valid JSON object missing books/genres arrays', async () => {
    await fs.mkdir(path.dirname(libraryFile), { recursive: true })
    await fs.writeFile(libraryFile, JSON.stringify({ something: 'else' }), 'utf-8')
    const store = createLibraryStore(libraryFile)
    await store.load()
    expect(store.list()).toEqual({ books: [], genres: [] })
  })
})
