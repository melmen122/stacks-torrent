import { describe, it, expect } from 'vitest'
import { parseRange } from '../electron/lib/mediaRange.js'

const SIZE = 1000

describe('parseRange', () => {
  it('returns null when no Range header is present (serve whole file)', () => {
    expect(parseRange(null, SIZE)).toBeNull()
    expect(parseRange(undefined, SIZE)).toBeNull()
    expect(parseRange('', SIZE)).toBeNull()
  })

  it('parses a normal closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
    expect(parseRange('bytes=200-299', SIZE)).toEqual({ start: 200, end: 299 })
  })

  it('parses a single-byte range', () => {
    expect(parseRange('bytes=0-0', SIZE)).toEqual({ start: 0, end: 0 })
    expect(parseRange('bytes=999-999', SIZE)).toEqual({ start: 999, end: 999 })
  })

  it('parses an open-ended range to end of file', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 })
  })

  it('clamps an end past the last byte to size-1', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 })
  })

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-1', SIZE)).toEqual({ start: 999, end: 999 })
  })

  it('clamps a suffix range longer than the file to the whole file', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 })
  })

  it('returns unsatisfiable (416) for bytes=-0 (zero-length suffix)', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true })
  })

  it('returns unsatisfiable (416) when start >= size', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ unsatisfiable: true })
    expect(parseRange('bytes=1000-1500', SIZE)).toEqual({ unsatisfiable: true })
    expect(parseRange('bytes=99999-', SIZE)).toEqual({ unsatisfiable: true })
  })

  it('returns unsatisfiable (416) when start > end', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ unsatisfiable: true })
  })

  it('returns unsatisfiable (416) for malformed headers', () => {
    expect(parseRange('bytes=abc', SIZE)).toEqual({ unsatisfiable: true })
    expect(parseRange('bytes', SIZE)).toEqual({ unsatisfiable: true })
    expect(parseRange('items=0-499', SIZE)).toEqual({ unsatisfiable: true })
    expect(parseRange('0-499', SIZE)).toEqual({ unsatisfiable: true })
  })

  it('returns unsatisfiable for any range against a zero-byte file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ unsatisfiable: true })
    expect(parseRange('bytes=0-0', 0)).toEqual({ unsatisfiable: true })
    expect(parseRange('bytes=-1', 0)).toEqual({ unsatisfiable: true })
  })

  it('serves only the first range of a multipart range request (lenient)', () => {
    // Documented actual behavior: the regex grabs the first "a-b" pair and
    // ignores the rest instead of producing a multipart/byteranges response.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ start: 0, end: 99 })
  })

  it('treats "bytes=-" (no start, no end) as the whole file, not 416', () => {
    // Documented actual behavior: RFC 9110 calls "bytes=-" invalid, but this
    // parser falls through to start=0/end=size-1. Harmless (a full-file 206)
    // but recorded here so a future change is deliberate.
    expect(parseRange('bytes=-', SIZE)).toEqual({ start: 0, end: 999 })
  })
})
