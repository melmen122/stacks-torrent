// scripts/verify-installer.mjs
//
// Post-build integrity gate for the Windows NSIS installer. electron-builder's
// app-builder step compresses release/win-unpacked into an NSIS payload
// ($PLUGINSDIR\app-64.7z) using 7z. That compression step has been observed
// to silently produce a payload whose 7z headers look correct (`7z l`
// reports fine) but whose compressed data streams are corrupt -- `7z l`
// only reads headers and never decompresses anything, so it cannot catch
// this. This script extracts the payload from the freshly built installer
// and runs `7z t`, which actually decompresses and CRC-checks every entry,
// then double-checks the main executable's real extracted bytes (size and
// SHA-256) against the known-good file in release/win-unpacked. Wired into
// `npm run dist:win` so a corrupt installer can never ship silently again.
//
// Scope: this gate verifies that the installer's embedded payload matches
// release/win-unpacked byte-for-byte (for the main exe) and that every
// entry in the payload decompresses cleanly. It does NOT verify that
// win-unpacked itself is a valid PE/executable, and it does NOT
// integrity-check the NSIS stub or the bundled uninstaller.

import {
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const releaseDir = join(rootDir, 'release')

function fail(message) {
  throw new Error(message)
}

function findSevenZip() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe'),
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], '7-Zip', '7z.exe')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Fall back to whatever `7z` resolves to on PATH, if anything.
  const probe = spawnSync('7z', [], { encoding: 'utf8' })
  if (!probe.error) return '7z'

  return null
}

function run7z(sevenZip, args) {
  return spawnSync(sevenZip, args, { encoding: 'utf8' })
}

// Pure selection logic, exported for unit testing without a real build.
// `files` is a flat list of filenames (as returned by readdirSync), NOT
// full paths. Selection is by filename containing `version` -- ambiguity
// (zero or more than one match) is a hard failure, never a guess, because
// a stale installer from a previous version left in release/ must never be
// silently substituted for the one just built.
export function selectInstaller(files, version) {
  if (!version) {
    throw new Error('selectInstaller: version is required')
  }

  const exeCandidates = files.filter((f) => f.toLowerCase().endsWith('.exe') && !f.includes('__uninstaller'))

  if (exeCandidates.length === 0) {
    throw new Error(`no installer .exe found`)
  }

  const matches = exeCandidates.filter((f) => f.includes(version))

  if (matches.length === 0) {
    throw new Error(
      `no installer .exe found containing version "${version}" in its filename. ` +
        `Candidates present: ${exeCandidates.join(', ')}`
    )
  }

  if (matches.length > 1) {
    throw new Error(
      `ambiguous installer selection: ${matches.length} .exe files contain version "${version}": ` +
        matches.join(', ')
    )
  }

  return matches[0]
}

function findInstaller(version) {
  if (!existsSync(releaseDir)) {
    fail(`release directory not found at ${releaseDir}. Run the build first.`)
  }

  const files = readdirSync(releaseDir)
  const chosen = selectInstaller(files, version)
  return join(releaseDir, chosen)
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function main() {
  const installerOverride = process.argv[2]

  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const productName = pkg.build?.productName || pkg.productName || pkg.name
  const mainExeName = `${productName}.exe`

  let tempDir = null
  let exitCode = 0

  try {
    // An explicit path (argv[2]) bypasses selection entirely -- used for
    // testing against arbitrary/corrupted installer copies.
    let installerPath
    if (installerOverride) {
      installerPath = resolve(process.cwd(), installerOverride)
      if (!existsSync(installerPath)) {
        fail(`installer override path does not exist: ${installerPath}`)
      }
    } else {
      installerPath = findInstaller(pkg.version)
    }

    const unpackedExePath = join(releaseDir, 'win-unpacked', mainExeName)

    console.log(`[verify:installer] installer: ${installerPath}`)

    if (!existsSync(unpackedExePath)) {
      fail(`expected unpacked exe not found at ${unpackedExePath}`)
    }
    const expectedSize = statSync(unpackedExePath).size
    const expectedHash = await sha256File(unpackedExePath)

    const sevenZip = findSevenZip()
    if (!sevenZip) {
      fail(
        'could not locate 7z.exe (checked %ProgramFiles(x86)%\\7-Zip\\7z.exe, ' +
          '%ProgramFiles%\\7-Zip\\7z.exe, and PATH). Install 7-Zip or add it ' +
          'to PATH -- refusing to silently pass the integrity check.'
      )
    }
    console.log(`[verify:installer] using 7z: ${sevenZip}`)

    tempDir = mkdtempSync(join(tmpdir(), 'verify-installer-'))

    // Step 1: pull the NSIS payload archive out of the installer itself.
    const extractPayload = run7z(sevenZip, ['x', installerPath, `-o${tempDir}`, '$PLUGINSDIR\\app-64.7z', '-y'])
    if (extractPayload.status !== 0) {
      console.error(extractPayload.stdout)
      console.error(extractPayload.stderr)
      fail(`could not extract $PLUGINSDIR\\app-64.7z from ${installerPath}`)
    }

    const payloadPath = join(tempDir, '$PLUGINSDIR', 'app-64.7z')
    if (!existsSync(payloadPath)) {
      fail(`expected NSIS payload not found at ${payloadPath} -- installer layout may have changed`)
    }

    // Step 2: the real gate. `7z t` decompresses and CRC-checks every entry;
    // `7z l` only reads headers and would NOT have caught the corruption this
    // script exists to prevent. The exit code is the primary signal; the
    // stdout regex is a fail-closed backstop, anchored to a line starting
    // with "ERROR" so it doesn't false-positive on payload filenames that
    // legitimately contain the substring "error" (e.g. RTCError.cjs).
    const test = run7z(sevenZip, ['t', payloadPath])
    console.log(test.stdout)
    if (test.status !== 0 || /^ERROR/mi.test(test.stdout) || !/Everything is Ok/.test(test.stdout)) {
      console.error(test.stderr)
      fail(`7z t reported errors testing ${payloadPath} -- the installer payload is corrupt`)
    }

    // Step 3: extract the main exe and confirm its real, decompressed bytes
    // match the known-good source file (size and SHA-256). This is what
    // actually caught the original corruption (declared header size was
    // correct; decompressed bytes were not), so `7z t` alone plus a
    // header-size check would not be sufficient here -- we extract for real.
    // Uses `7z x` with the exact in-archive path (no `-r` recursive search)
    // so it cannot match a same-named file in a subdirectory and silently
    // overwrite/extract the wrong one.
    const exeExtractDir = join(tempDir, 'exe-check')
    mkdirSync(exeExtractDir, { recursive: true })
    const extractExe = run7z(sevenZip, ['x', payloadPath, `-o${exeExtractDir}`, mainExeName, '-y'])
    if (extractExe.status !== 0) {
      console.error(extractExe.stdout)
      console.error(extractExe.stderr)
      fail(`could not extract ${mainExeName} from ${payloadPath}`)
    }

    const extractedExePath = join(exeExtractDir, mainExeName)
    if (!existsSync(extractedExePath)) {
      fail(`${mainExeName} not found after extraction from ${payloadPath}`)
    }

    const actualSize = statSync(extractedExePath).size
    if (actualSize !== expectedSize) {
      fail(
        `${mainExeName} extracted from the installer is ${actualSize} bytes but ` +
          `${unpackedExePath} is ${expectedSize} bytes -- the installer payload is corrupt`
      )
    }

    const actualHash = await sha256File(extractedExePath)
    if (actualHash !== expectedHash) {
      fail(
        `${mainExeName} extracted from the installer has SHA-256 ${actualHash} but ` +
          `${unpackedExePath} has SHA-256 ${expectedHash} -- the installer payload is corrupt`
      )
    }

    console.log(
      `[verify:installer] OK -- ${payloadPath} tested clean and ${mainExeName} extracted at the expected ` +
        `size (${actualSize} bytes) and SHA-256 (${actualHash})`
    )
  } catch (err) {
    console.error(`[verify:installer] FAILED: ${err.message}`)
    exitCode = 1
  } finally {
    // Cleanup must never mask the original failure (or success) above, and
    // must always run even on failure -- process.exit() does not run
    // `finally` blocks, so the exit happens after this block completes,
    // outside the try/catch/finally, not from inside the catch.
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (cleanupErr) {
        console.error(`[verify:installer] warning: failed to clean up temp dir ${tempDir}: ${cleanupErr.message}`)
      }
    }
  }

  process.exit(exitCode)
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main()
}
