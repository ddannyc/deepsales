import { describe, expect, it } from 'vitest'
import { validateMediaFile } from './media-files'

describe('private outbound media boundaries', () => {
  it.each([
    ['guide.pdf', 'application/pdf', '%PDF-guide', 'FILE'],
    ['guide.txt', 'text/plain; charset=utf-8', 'Hello', 'FILE'],
    ['recording.wav', 'audio/wav', 'RIFF0000WAVE', 'AUDIO'],
    ['recording.mp3', 'audio/mpeg', 'ID3audio', 'AUDIO'],
    ['recording.ogg', 'audio/ogg', 'OggSaudio', 'AUDIO'],
    ['recording.m4a', 'audio/mp4', '0000ftyp', 'AUDIO'],
    ['clip.mp4', 'video/mp4', '0000ftyp', 'VIDEO'],
  ])('accepts the declared channel format for %s', (filename, mime, data, kind) => {
    expect(validateMediaFile(filename, mime, new TextEncoder().encode(data))).toMatchObject({
      kind,
    })
  })

  it('rejects empty files, invalid UTF-8, MIME mismatch and oversized files', () => {
    expect(() => validateMediaFile('guide.txt', 'text/plain', new Uint8Array())).toThrow()
    expect(() => validateMediaFile('guide.txt', 'text/plain', new Uint8Array([255]))).toThrow()
    expect(() =>
      validateMediaFile('guide.txt', 'application/pdf', new TextEncoder().encode('Hello')),
    ).toThrow()
    expect(() =>
      validateMediaFile('guide.pdf', 'application/pdf', new Uint8Array(25 * 1024 * 1024 + 1)),
    ).toThrow()
  })

  it('accepts a PNG and rejects a spoofed MIME, active content and oversized image', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    expect(validateMediaFile('diagram.png', 'image/png', png)).toMatchObject({
      kind: 'IMAGE',
      mimeType: 'image/png',
    })
    expect(() =>
      validateMediaFile('diagram.png', 'image/png', new TextEncoder().encode('<script>')),
    ).toThrow()
    expect(() => validateMediaFile('diagram.svg', 'image/svg+xml', png)).toThrow()
    expect(() =>
      validateMediaFile('diagram.png', 'image/png', new Uint8Array(8 * 1024 * 1024 + 1)),
    ).toThrow()
  })
})
