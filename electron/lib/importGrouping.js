// electron/lib/importGrouping.js
//
// Grouping logic for turning a list of user- or drag-and-drop-selected
// paths into book-shaped file groups, per docs/PLAN2.md's exact rules:
//   - a directory whose immediate children include audio files -> one book
//     from that directory (recursively collecting all audio beneath it)
//   - a directory with NO direct audio, but ALL of its audio-bearing
//     subdirectories look like disc/part folders (e.g. "CD1", "Disc 2",
//     "part_03") -> one book for the whole parent directory (multi-disc
//     layout), with files ordered by disc folder (natural order) then
//     naturally within each disc
//   - a directory with NO direct audio, and its audio-bearing subdirectories
//     are NOT all disc-like (including a mix of disc-like and not) -> one
//     book per such subdirectory (bulk import)
//   - loose audio files passed in the same call -> grouped as one book
//
// Shared by both `library:import` (native dialog) and `library:importPaths`
// (drag & drop) so the grouping rules only live in one place. Uses node:fs
// directly (no Electron/`app` dependency) so it's importable/testable with
// a plain temp-directory fixture.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { isAudioFile, naturalCompare, sortAudioFilesNaturally } from './metadata.js'

// Matches "CD1", "Disc 2", "disk_03", "part-4", etc. — a disc/part keyword
// optionally followed by separator characters, then a number, and nothing else.
const DISC_FOLDER_RE = /^(cd|disc|disk|part)[\s._-]*\d+$/i

async function listDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function collectAudioFilesRecursive(dir) {
  const out = []
  async function walk(current) {
    const entries = await listDir(current)
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && isAudioFile(full)) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

/**
 * Group one directory according to the PLAN2 rules. Returns an array of
 * groups — usually one (direct audio, or an all-disc-like multi-disc
 * merge), but "bulk import" of a directory-of-subdirectories produces one
 * group per subdirectory — or an empty array if nothing audio-shaped was
 * found anywhere under it.
 */
async function groupDirectory(dir) {
  const entries = await listDir(dir)
  const directAudio = entries.filter((e) => e.isFile() && isAudioFile(e.name))

  if (directAudio.length) {
    // Audio directly inside this directory -> one book, recursively
    // collecting everything beneath it (so nested "disc 1/disc 2" style
    // subfolders still get pulled into the same book).
    const files = await collectAudioFilesRecursive(dir)
    return files.length
      ? [{ files, folderName: path.basename(dir), coverDir: dir }]
      : []
  }

  const subdirs = entries.filter((e) => e.isDirectory())
  if (!subdirs.length) return []

  // Only subdirectories that actually contain audio somewhere beneath them
  // count towards the multi-disc-vs-bulk-import decision below; an empty or
  // irrelevant sibling folder (e.g. "Artwork") shouldn't disqualify an
  // otherwise all-disc-like layout.
  const audioBearingSubdirs = []
  for (const subdir of subdirs) {
    const subdirPath = path.join(dir, subdir.name)
    const files = await collectAudioFilesRecursive(subdirPath)
    if (files.length) audioBearingSubdirs.push({ name: subdir.name, path: subdirPath, files })
  }
  if (!audioBearingSubdirs.length) return []

  const isMultiDisc = audioBearingSubdirs.every((s) => DISC_FOLDER_RE.test(s.name.trim()))

  if (isMultiDisc) {
    // Multi-disc layout (e.g. "CD1"/"CD2", "Disc 1"/"Disc 2") -> the whole
    // parent directory is ONE book, not one per disc folder. Title/cover
    // fall back to the *parent* folder's name (e.g. "Dune"), not "CD1".
    // Files must be ordered by disc folder (natural order) then naturally
    // within each disc — NOT a flat basename-only sort — since disc
    // folders commonly reuse the same track numbering (each disc's own
    // "01.mp3", "02.mp3", ...), which would otherwise interleave tracks
    // across discs instead of keeping each disc's tracks together in order.
    const orderedSubdirs = [...audioBearingSubdirs].sort((a, b) => naturalCompare(a.name, b.name))
    const files = orderedSubdirs.flatMap((s) => sortAudioFilesNaturally(s.files))
    return [{ files, folderName: path.basename(dir), coverDir: dir }]
  }

  // Bulk import: no audio directly in `dir`, and its audio-bearing
  // subdirectories aren't ALL disc-like (including a mix of disc-like and
  // not) -> one book per such subdirectory, same as before.
  return audioBearingSubdirs.map((s) => ({ files: s.files, folderName: s.name, coverDir: s.path }))
}

/**
 * @param {string[]} paths - absolute paths (files and/or directories).
 * @returns {Promise<{
 *   groups: Array<{files: string[], folderName: string, coverDir: string}>,
 *   skipped: string[]
 * }>} `skipped` lists input paths that yielded no audio at all (including
 *   paths that don't exist or resolve to a non-audio loose file).
 */
export async function groupImportPaths(paths) {
  const groups = []
  const skipped = []
  const looseFiles = []
  let looseFilesParentDir = null

  for (const inputPath of paths) {
    const stat = await fs.stat(inputPath).catch(() => null)
    if (!stat) {
      skipped.push(inputPath)
      continue
    }

    if (stat.isDirectory()) {
      const dirGroups = await groupDirectory(inputPath)
      if (dirGroups.length) {
        groups.push(...dirGroups)
      } else {
        skipped.push(inputPath)
      }
      continue
    }

    if (stat.isFile() && isAudioFile(inputPath)) {
      looseFiles.push(inputPath)
      if (!looseFilesParentDir) looseFilesParentDir = path.dirname(inputPath)
      continue
    }

    // A file that isn't a recognized audio extension.
    skipped.push(inputPath)
  }

  if (looseFiles.length) {
    groups.push({
      files: looseFiles,
      folderName: path.basename(looseFilesParentDir),
      coverDir: looseFilesParentDir
    })
  }

  return { groups, skipped }
}
