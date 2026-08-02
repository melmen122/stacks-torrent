import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { groupImportPaths } from '../electron/lib/importGrouping.js'

let root

async function make(relPath, content = 'x') {
  const full = path.join(root, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

async function makeDir(relPath) {
  const full = path.join(root, relPath)
  await fs.mkdir(full, { recursive: true })
  return full
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'import-grouping-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('groupImportPaths', () => {
  it('groups a directory with direct audio files as one book', async () => {
    await make('Book A/track1.mp3')
    await make('Book A/track2.mp3')
    await make('Book A/notes.txt')
    const { groups, skipped } = await groupImportPaths([path.join(root, 'Book A')])
    expect(skipped).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0].folderName).toBe('Book A')
    expect(groups[0].coverDir).toBe(path.join(root, 'Book A'))
    expect(groups[0].files.map((f) => path.basename(f)).sort()).toEqual([
      'track1.mp3',
      'track2.mp3'
    ])
  })

  it('pulls nested disc subfolders into the same book when the dir has direct audio', async () => {
    await make('Book B/intro.mp3')
    await make('Book B/Disc 1/01.mp3')
    await make('Book B/Disc 2/01.mp3')
    const { groups } = await groupImportPaths([path.join(root, 'Book B')])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(3)
  })

  it('groups a directory of subdirectories-with-audio as one book per subdirectory', async () => {
    await make('Library/Book One/ch1.mp3')
    await make('Library/Book One/ch2.mp3')
    await make('Library/Book Two/part1.m4b')
    await make('Library/Empty Book/readme.txt')
    const { groups, skipped } = await groupImportPaths([path.join(root, 'Library')])
    expect(skipped).toEqual([])
    expect(groups).toHaveLength(2)
    const names = groups.map((g) => g.folderName).sort()
    expect(names).toEqual(['Book One', 'Book Two'])
    const bookOne = groups.find((g) => g.folderName === 'Book One')
    expect(bookOne.files).toHaveLength(2)
    expect(bookOne.coverDir).toBe(path.join(root, 'Library', 'Book One'))
  })

  it('groups loose audio files passed together as a single book named after their parent dir', async () => {
    const f1 = await make('Loose/track1.mp3')
    const f2 = await make('Loose/track2.mp3')
    const { groups, skipped } = await groupImportPaths([f1, f2])
    expect(skipped).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toEqual([f1, f2])
    expect(groups[0].folderName).toBe('Loose')
    expect(groups[0].coverDir).toBe(path.join(root, 'Loose'))
  })

  it('skips an empty directory', async () => {
    const dir = await makeDir('Empty')
    const { groups, skipped } = await groupImportPaths([dir])
    expect(groups).toEqual([])
    expect(skipped).toEqual([dir])
  })

  it('skips a directory containing no audio anywhere', async () => {
    await make('Docs/readme.txt')
    await make('Docs/sub/notes.md')
    const { groups, skipped } = await groupImportPaths([path.join(root, 'Docs')])
    expect(groups).toEqual([])
    expect(skipped).toEqual([path.join(root, 'Docs')])
  })

  it('skips a loose non-audio file', async () => {
    const txt = await make('stray.txt')
    const { groups, skipped } = await groupImportPaths([txt])
    expect(groups).toEqual([])
    expect(skipped).toEqual([txt])
  })

  it('skips a path that does not exist', async () => {
    const ghost = path.join(root, 'nope', 'missing.mp3')
    const { groups, skipped } = await groupImportPaths([ghost])
    expect(groups).toEqual([])
    expect(skipped).toEqual([ghost])
  })

  it('merges an all-disc-folder directory into a single multi-disc book, files ordered by disc then track', async () => {
    await make('Dune/CD1/02.mp3')
    await make('Dune/CD1/01.mp3')
    await make('Dune/CD2/02.mp3')
    await make('Dune/CD2/01.mp3')
    const { groups, skipped } = await groupImportPaths([path.join(root, 'Dune')])
    expect(skipped).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0].folderName).toBe('Dune')
    expect(groups[0].coverDir).toBe(path.join(root, 'Dune'))
    expect(groups[0].files).toEqual([
      path.join(root, 'Dune', 'CD1', '01.mp3'),
      path.join(root, 'Dune', 'CD1', '02.mp3'),
      path.join(root, 'Dune', 'CD2', '01.mp3'),
      path.join(root, 'Dune', 'CD2', '02.mp3')
    ])
  })

  it('orders disc folders naturally, not lexically, when merging a multi-disc book', async () => {
    await make('Book/Disc 10/01.mp3')
    await make('Book/Disc 2/01.mp3')
    const { groups } = await groupImportPaths([path.join(root, 'Book')])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toEqual([
      path.join(root, 'Book', 'Disc 2', '01.mp3'),
      path.join(root, 'Book', 'Disc 10', '01.mp3')
    ])
  })

  it('recognizes disc/disk/part keyword variants with different separators, case-insensitively', async () => {
    await make('Variants/disk_02/track.mp3')
    await make('Variants/PART-1/track.mp3')
    const { groups } = await groupImportPaths([path.join(root, 'Variants')])
    expect(groups).toHaveLength(1)
    expect(groups[0].folderName).toBe('Variants')
  })

  it('ignores an empty non-disc sibling folder when deciding a layout is all-disc-like', async () => {
    await make('Dune2/CD1/01.mp3')
    await make('Dune2/CD2/01.mp3')
    await makeDir('Dune2/Artwork')
    const { groups } = await groupImportPaths([path.join(root, 'Dune2')])
    expect(groups).toHaveLength(1)
    expect(groups[0].folderName).toBe('Dune2')
  })

  it('falls back to one-book-per-subdirectory when subdirs are a MIX of disc-like and non-disc-like names', async () => {
    await make('Mixed/CD1/01.mp3')
    await make('Mixed/Bonus Material/extra.mp3')
    const { groups, skipped } = await groupImportPaths([path.join(root, 'Mixed')])
    expect(skipped).toEqual([])
    expect(groups).toHaveLength(2)
    const names = groups.map((g) => g.folderName).sort()
    expect(names).toEqual(['Bonus Material', 'CD1'])
  })

  it('handles a mixed call: directory + loose files + junk in one pass', async () => {
    await make('Mixed Book/ch1.mp3')
    const loose = await make('elsewhere/solo.m4a')
    const junk = await make('junk.pdf')
    const { groups, skipped } = await groupImportPaths([
      path.join(root, 'Mixed Book'),
      loose,
      junk
    ])
    expect(groups).toHaveLength(2)
    expect(skipped).toEqual([junk])
    const folderNames = groups.map((g) => g.folderName).sort()
    expect(folderNames).toEqual(['Mixed Book', 'elsewhere'])
  })

  it('recognizes audio extensions case-insensitively when grouping', async () => {
    await make('Caps/TRACK1.MP3')
    const { groups } = await groupImportPaths([path.join(root, 'Caps')])
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => path.basename(f))).toEqual(['TRACK1.MP3'])
  })

  it('returns empty results for an empty input list', async () => {
    const { groups, skipped } = await groupImportPaths([])
    expect(groups).toEqual([])
    expect(skipped).toEqual([])
  })
})
