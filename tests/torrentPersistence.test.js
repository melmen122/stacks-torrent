import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import {
  loadPersistedTorrents,
  savePersistedTorrents
} from '../electron/lib/torrentPersistence.js'

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-persist-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const sampleEntries = [
  {
    magnetOrInfoHash: 'magnet:?xt=urn:btih:abc123',
    torrentFileCopyPath: null,
    downloadDir: '/downloads/book-a',
    paused: false,
    addedAt: 1700000000000
  },
  {
    magnetOrInfoHash: 'def456',
    torrentFileCopyPath: '/userData/torrents/def456.torrent',
    downloadDir: '/downloads/book-b',
    paused: true,
    addedAt: 1700000001000
  }
]

describe('torrentPersistence', () => {
  it('returns [] when the file does not exist', async () => {
    const result = await loadPersistedTorrents(path.join(root, 'torrents.json'))
    expect(result).toEqual([])
  })

  it('round-trips entries through save and load', async () => {
    const file = path.join(root, 'torrents.json')
    await savePersistedTorrents(file, sampleEntries)
    const loaded = await loadPersistedTorrents(file)
    expect(loaded).toEqual(sampleEntries)
  })

  it('creates missing parent directories on save', async () => {
    const file = path.join(root, 'deep', 'nested', 'torrents.json')
    await savePersistedTorrents(file, sampleEntries)
    expect(await loadPersistedTorrents(file)).toEqual(sampleEntries)
  })

  it('leaves no .tmp file behind after a save (atomic write)', async () => {
    const file = path.join(root, 'torrents.json')
    await savePersistedTorrents(file, sampleEntries)
    await savePersistedTorrents(file, [])
    const leftovers = (await fs.readdir(root)).filter((n) => n !== 'torrents.json')
    expect(leftovers).toEqual([])
  })

  it('overwrites previous contents completely on save', async () => {
    const file = path.join(root, 'torrents.json')
    await savePersistedTorrents(file, sampleEntries)
    await savePersistedTorrents(file, [sampleEntries[0]])
    const loaded = await loadPersistedTorrents(file)
    expect(loaded).toEqual([sampleEntries[0]])
  })

  it('returns [] when the file contains valid JSON that is not an array', async () => {
    const file = path.join(root, 'torrents.json')
    await fs.writeFile(file, JSON.stringify({ not: 'an array' }), 'utf-8')
    expect(await loadPersistedTorrents(file)).toEqual([])
  })

  it('throws (rather than silently wiping) on corrupt JSON', async () => {
    const file = path.join(root, 'torrents.json')
    await fs.writeFile(file, '{ this is not json', 'utf-8')
    await expect(loadPersistedTorrents(file)).rejects.toThrow()
  })

  it('saves an empty list as a loadable empty array', async () => {
    const file = path.join(root, 'torrents.json')
    await savePersistedTorrents(file, [])
    expect(await loadPersistedTorrents(file)).toEqual([])
  })
})
