import { describe, it, expect } from 'vitest'
import { isMagnetUri, parseMagnetFromArgv } from '../electron/lib/magnetLink.js'

describe('isMagnetUri', () => {
  it('accepts a real magnet URI', () => {
    expect(isMagnetUri('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10')).toBe(true)
  })

  it('rejects non-string values', () => {
    expect(isMagnetUri(undefined)).toBe(false)
    expect(isMagnetUri(null)).toBe(false)
    expect(isMagnetUri(42)).toBe(false)
  })

  it('rejects strings that merely contain "magnet:" but do not start with it', () => {
    expect(isMagnetUri('see magnet:?xt=urn:btih:abc')).toBe(false)
  })

  it('rejects other URI schemes and plain paths', () => {
    expect(isMagnetUri('https://example.com/magnet:fake')).toBe(false)
    expect(isMagnetUri('/Applications/Audiobook Library.app/Contents/MacOS/Audiobook Library')).toBe(false)
  })
})

describe('parseMagnetFromArgv', () => {
  it('finds a magnet URI anywhere in argv', () => {
    const argv = ['/usr/bin/electron', '.', 'magnet:?xt=urn:btih:abc']
    expect(parseMagnetFromArgv(argv)).toBe('magnet:?xt=urn:btih:abc')
  })

  it('returns null when no magnet token is present', () => {
    const argv = ['/usr/bin/electron', '.', '--flag', '--flag=value']
    expect(parseMagnetFromArgv(argv)).toBeNull()
  })

  it('does not misfire on the app executable path or electron-dev args', () => {
    const argv = [
      'C:\\Program Files\\Audiobook Library\\Audiobook Library.exe',
      '--original-process-start-time=13398624000000000',
      '--inspect',
      String.raw`C:\Users\me\AppData\Local\Programs\electron\electron.exe`
    ]
    expect(parseMagnetFromArgv(argv)).toBeNull()
  })

  it('returns null for a non-array input', () => {
    expect(parseMagnetFromArgv(undefined)).toBeNull()
    expect(parseMagnetFromArgv(null)).toBeNull()
  })

  it('returns null for an empty argv', () => {
    expect(parseMagnetFromArgv([])).toBeNull()
  })

  it('picks the first magnet token when multiple are present', () => {
    const argv = ['magnet:?xt=urn:btih:first', 'magnet:?xt=urn:btih:second']
    expect(parseMagnetFromArgv(argv)).toBe('magnet:?xt=urn:btih:first')
  })
})
