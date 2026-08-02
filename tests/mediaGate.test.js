import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveMediaAccess } from '../electron/lib/mediaGate.js'

// Pure path logic — no filesystem access needed, so fixed fake paths are fine.
const COVERS = path.join(path.sep, 'app', 'userData', 'covers')

describe('resolveMediaAccess', () => {
  describe('audio extension allowlist', () => {
    it('allows allowlisted audio extensions anywhere on disk', () => {
      for (const ext of ['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.ogg', '.opus', '.wav']) {
        const p = path.join(path.sep, 'somewhere', 'else', `book${ext}`)
        expect(resolveMediaAccess(p, COVERS).allowed).toBe(true)
      }
    })

    it('matches extensions case-insensitively', () => {
      const p = path.join(path.sep, 'library', 'BOOK.MP3')
      const result = resolveMediaAccess(p, COVERS)
      expect(result.allowed).toBe(true)
      expect(result.ext).toBe('.mp3')
    })

    it('forbids non-audio extensions outside the covers dir', () => {
      for (const name of ['x.txt', 'x.html', 'x.js', 'passwd', 'x.jpg', 'x.mp3.txt']) {
        const p = path.join(path.sep, 'somewhere', name)
        expect(resolveMediaAccess(p, COVERS).allowed).toBe(false)
      }
    })

    it('forbids an extensionless file outside the covers dir', () => {
      expect(resolveMediaAccess(path.join(path.sep, 'etc', 'hosts'), COVERS).allowed).toBe(false)
    })
  })

  describe('covers-dir boundary', () => {
    it('allows any file inside the covers dir (e.g. cover images)', () => {
      expect(resolveMediaAccess(path.join(COVERS, 'b123.jpg'), COVERS).allowed).toBe(true)
      expect(resolveMediaAccess(path.join(COVERS, 'nested', 'b.png'), COVERS).allowed).toBe(true)
    })

    it('forbids a sibling directory whose name merely starts with the covers dir name', () => {
      // Security-critical: "<userData>/covers-evil/x.jpg" must NOT pass the
      // prefix check for "<userData>/covers".
      const evil = path.join(path.sep, 'app', 'userData', 'covers-evil', 'x.jpg')
      expect(resolveMediaAccess(evil, COVERS).allowed).toBe(false)

      const evil2 = `${COVERS}evil${path.sep}x.jpg`
      expect(resolveMediaAccess(evil2, COVERS).allowed).toBe(false)
    })

    it('forbids escaping the covers dir via .. traversal', () => {
      const traversal = path.join(COVERS, '..', 'secrets.jpg')
      const result = resolveMediaAccess(traversal, COVERS)
      expect(result.allowed).toBe(false)
      expect(result.resolvedPath).toBe(path.join(path.sep, 'app', 'userData', 'secrets.jpg'))
    })

    it('forbids deep traversal that tunnels through covers back out to system files', () => {
      const traversal = path.join(COVERS, '..', '..', '..', 'etc', 'shadow')
      expect(resolveMediaAccess(traversal, COVERS).allowed).toBe(false)
    })

    it('still allows a path that traverses but resolves back inside covers', () => {
      const p = path.join(COVERS, 'sub', '..', 'b1.jpg')
      const result = resolveMediaAccess(p, COVERS)
      expect(result.allowed).toBe(true)
      expect(result.resolvedPath).toBe(path.join(COVERS, 'b1.jpg'))
    })

    it('treats the covers dir itself as within bounds', () => {
      expect(resolveMediaAccess(COVERS, COVERS).allowed).toBe(true)
    })

    it('handles a coversDir passed with a trailing separator', () => {
      const inCovers = path.join(COVERS, 'b1.jpg')
      expect(resolveMediaAccess(inCovers, COVERS + path.sep).allowed).toBe(true)
      const evil = path.join(path.sep, 'app', 'userData', 'covers-evil', 'x.jpg')
      expect(resolveMediaAccess(evil, COVERS + path.sep).allowed).toBe(false)
    })
  })

  it('returns the resolved path and lowercased extension for the caller', () => {
    const result = resolveMediaAccess(path.join(path.sep, 'a', 'B.M4B'), COVERS)
    expect(result.resolvedPath).toBe(path.join(path.sep, 'a', 'B.M4B'))
    expect(result.ext).toBe('.m4b')
  })
})
