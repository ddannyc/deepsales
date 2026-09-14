import mammoth from 'mammoth'
import type { KnowledgeFileSourceType } from '@deepsales/db'
import { extractText, getDocumentProxy } from 'unpdf'

export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024

export type KnowledgeFileDescriptor = {
  extension: 'pdf' | 'docx' | 'txt' | 'md' | 'markdown'
  sourceType: KnowledgeFileSourceType
  mimeType: string
}

export type KnowledgeFileErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'MIME_MISMATCH'
  | 'INVALID_FILE_SIGNATURE'
  | 'TOO_LARGE'
  | 'INVALID_UTF8'
  | 'FILE_EXTRACTION_FAILED'

export class KnowledgeFileError extends Error {
  constructor(readonly code: KnowledgeFileErrorCode) {
    super(code)
  }
}

const fileTypes: Record<string, KnowledgeFileDescriptor> = {
  pdf: { extension: 'pdf', sourceType: 'PDF', mimeType: 'application/pdf' },
  docx: {
    extension: 'docx',
    sourceType: 'DOCX',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  txt: { extension: 'txt', sourceType: 'TXT', mimeType: 'text/plain' },
  md: { extension: 'md', sourceType: 'MARKDOWN', mimeType: 'text/markdown' },
  markdown: { extension: 'markdown', sourceType: 'MARKDOWN', mimeType: 'text/markdown' },
}

export function knowledgeFileTypeForName(filename: string) {
  const extension = filename.trim().toLowerCase().split('.').pop()
  return extension && Object.hasOwn(fileTypes, extension) ? fileTypes[extension] : null
}

export function validateKnowledgeFile(
  filename: string,
  declaredMimeType: string,
  bytes: Uint8Array,
) {
  const fileType = knowledgeFileTypeForName(filename)
  if (!fileType) throw new KnowledgeFileError('UNSUPPORTED_FILE_TYPE')
  if (bytes.byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new KnowledgeFileError('TOO_LARGE')
  }

  const mimeType = declaredMimeType.split(';', 1)[0]?.trim().toLowerCase()
  const mimeMatches =
    mimeType === fileType.mimeType ||
    (fileType.sourceType === 'MARKDOWN' && mimeType === 'text/x-markdown')
  if (!mimeMatches) throw new KnowledgeFileError('MIME_MISMATCH')

  if (fileType.sourceType === 'PDF' && !hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new KnowledgeFileError('INVALID_FILE_SIGNATURE')
  }
  if (fileType.sourceType === 'DOCX' && !hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new KnowledgeFileError('INVALID_FILE_SIGNATURE')
  }
  return { ...fileType, mimeType: mimeType === 'text/x-markdown' ? 'text/markdown' : mimeType }
}

export async function readKnowledgeFileBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const result = await reader.read()
    if (result.done) break
    byteLength += result.value.byteLength
    if (byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new KnowledgeFileError('TOO_LARGE')
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function extractKnowledgeText(
  sourceType: KnowledgeFileSourceType,
  bytes: Uint8Array,
): Promise<string> {
  if (sourceType === 'TXT' || sourceType === 'MARKDOWN') return decodeUtf8(bytes)

  try {
    if (sourceType === 'PDF') {
      const pdf = await getDocumentProxy(bytes)
      return (await extractText(pdf, { mergePages: true })).text
    }

    // Mammoth raw-text extraction does not resolve external parts; unlike HTML conversion it has no external file option.
    const result = await (mammoth as unknown as MammothRawText).extractRawText({
      arrayBuffer: bytes.slice().buffer,
      buffer: bytes,
    })
    if (result.messages.some(({ type }) => type === 'error')) {
      throw new Error('Mammoth reported an extraction error')
    }
    return result.value
  } catch {
    throw new KnowledgeFileError('FILE_EXTRACTION_FAILED')
  }
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new KnowledgeFileError('INVALID_UTF8')
  }
}

function hasPrefix(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((byte, index) => bytes[index] === byte)
}

type MammothRawText = {
  extractRawText(input: { arrayBuffer: ArrayBuffer; buffer: Uint8Array }): Promise<{
    value: string
    messages: Array<{ type: string }>
  }>
}
