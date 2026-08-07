import { describe, it, expect } from 'vitest'
import { selectInstaller } from '../scripts/verify-installer.mjs'

describe('selectInstaller', () => {
  it('exactly one installer matching the current version -> returns it', () => {
    const files = ['Audiobook Library Setup 0.1.0.exe', 'Audiobook Library Setup 0.1.0.exe.blockmap', 'latest.yml']
    expect(selectInstaller(files, '0.1.0')).toBe('Audiobook Library Setup 0.1.0.exe')
  })

  it('a stale different-version installer alongside the correct one -> returns the correct one, not the stale one', () => {
    // Regression guard for the false-PASS defect: a corrupt 0.1.0 installer
    // must never be shadowed by a good but stale 0.0.9 installer just
    // because release/ was not cleaned between builds.
    const files = ['Audiobook Library Setup 0.0.9.exe', 'Audiobook Library Setup 0.1.0.exe']
    expect(selectInstaller(files, '0.1.0')).toBe('Audiobook Library Setup 0.1.0.exe')
  })

  it('zero matches for the current version -> throws', () => {
    const files = ['Audiobook Library Setup 0.0.9.exe']
    expect(() => selectInstaller(files, '0.1.0')).toThrow(/no installer .exe found containing version "0\.1\.0"/)
  })

  it('two matches for the same version -> throws (ambiguity is an error, never a guess)', () => {
    const files = ['Audiobook Library Setup 0.1.0.exe', 'Audiobook Library Setup 0.1.0 (1).exe']
    expect(() => selectInstaller(files, '0.1.0')).toThrow(/ambiguous installer selection/)
  })

  it('no .exe files at all -> throws', () => {
    expect(() => selectInstaller(['latest.yml', 'builder-effective-config.yaml'], '0.1.0')).toThrow(
      /no installer .exe found/
    )
  })

  it('ignores the bundled uninstaller stub', () => {
    const files = ['Audiobook Library Setup 0.1.0.exe', '__uninstaller-nsis-Audiobook Library.exe']
    expect(selectInstaller(files, '0.1.0')).toBe('Audiobook Library Setup 0.1.0.exe')
  })

  it('throws when called without a version', () => {
    expect(() => selectInstaller(['Audiobook Library Setup 0.1.0.exe'], '')).toThrow(/version is required/)
  })
})
