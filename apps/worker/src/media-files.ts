import type { MessageAttachmentKind } from '@deepsales/db'

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const formats: Record<string, { mime: string; kind: MessageAttachmentKind }> = {
  png: { mime: 'image/png', kind: 'IMAGE' },
  jpg: { mime: 'image/jpeg', kind: 'IMAGE' },
  jpeg: { mime: 'image/jpeg', kind: 'IMAGE' },
  gif: { mime: 'image/gif', kind: 'IMAGE' },
  pdf: { mime: 'application/pdf', kind: 'FILE' },
  txt: { mime: 'text/plain', kind: 'FILE' },
  zip: { mime: 'application/zip', kind: 'FILE' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'FILE',
  },
  mp3: { mime: 'audio/mpeg', kind: 'AUDIO' },
  wav: { mime: 'audio/wav', kind: 'AUDIO' },
  ogg: { mime: 'audio/ogg', kind: 'AUDIO' },
  m4a: { mime: 'audio/mp4', kind: 'AUDIO' },
  mp4: { mime: 'video/mp4', kind: 'VIDEO' },
}

export function validateMediaFile(filename: string, declaredMime: string, bytes: Uint8Array) {
  const extension = filename.trim().toLowerCase().split('.').at(-1) ?? ''
  const format = Object.hasOwn(formats, extension) ? formats[extension] : undefined
  const mime = declaredMime.split(';', 1)[0].trim().toLowerCase()
  if (!format || mime !== format.mime || !filename.trim() || filename.length > 200)
    throw new Error('UNSUPPORTED_MEDIA_TYPE')
  if (!bytes.length || bytes.length > (format.kind === 'IMAGE' ? 8 * 1024 * 1024 : MAX_MEDIA_BYTES))
    throw new Error('MEDIA_TOO_LARGE_OR_EMPTY')
  const starts = (prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end))
  const valid =
    extension === 'png'
      ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : extension === 'jpg' || extension === 'jpeg'
        ? starts([255, 216, 255])
        : extension === 'gif'
          ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
          : extension === 'pdf'
            ? ascii(0, 5) === '%PDF-'
            : extension === 'zip' || extension === 'docx'
              ? starts([80, 75, 3, 4])
              : extension === 'wav'
                ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
                : extension === 'ogg'
                  ? ascii(0, 4) === 'OggS'
                  : extension === 'mp3'
                    ? ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)
                    : extension === 'mp4' || extension === 'm4a'
                      ? ascii(4, 8) === 'ftyp'
                      : extension === 'txt'
  if (!valid) throw new Error('INVALID_MEDIA_SIGNATURE')
  if (extension === 'txt') new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  return { kind: format.kind, mimeType: format.mime, filename: filename.trim() }
}
