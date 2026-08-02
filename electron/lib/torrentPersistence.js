// electron/lib/torrentPersistence.js
//
// Pure JSON read/write for userData/torrents.json (atomic tmp+rename write,
// same pattern as library.js/settings.json). No Electron/`app` dependency —
// the caller passes in the resolved file path, so this is importable/
// testable with a plain temp-file fixture.
//
// Entry shape (see docs/PLAN2.md "Torrent persistence"):
//   { magnetOrInfoHash: string, torrentFileCopyPath: string|null,
//     downloadDir: string, paused: boolean, addedAt: number }

import path from 'node:path'
import { promises as fs } from 'node:fs'

export async function loadPersistedTorrents(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return []
  }
}

export async function savePersistedTorrents(filePath, entries) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = path.join(dir, `.torrents.json.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8')
  await fs.rename(tmpPath, filePath)
}
