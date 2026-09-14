import mammoth from 'mammoth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractKnowledgeText,
  knowledgeFileTypeForName,
  MAX_KNOWLEDGE_FILE_BYTES,
  readKnowledgeFileBody,
  validateKnowledgeFile,
} from './knowledge-files'

afterEach(() => vi.restoreAllMocks())

describe('knowledge file validation', () => {
  it.each([
    ['guide.pdf', 'application/pdf', 'PDF', new TextEncoder().encode('%PDF-1.7')],
    [
      'guide.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'DOCX',
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    ],
    ['guide.txt', 'text/plain', 'TXT', new TextEncoder().encode('plain text')],
    ['guide.markdown', 'text/markdown', 'MARKDOWN', new TextEncoder().encode('# heading')],
  ])('accepts %s', (name, mimeType, sourceType, bytes) => {
    expect(validateKnowledgeFile(name, mimeType, bytes)).toEqual(
      expect.objectContaining({ sourceType, mimeType }),
    )
  })

  it('rejects a MIME mismatch and an invalid signature before storage', () => {
    expect(() =>
      validateKnowledgeFile('guide.pdf', 'text/plain', new Uint8Array([1])),
    ).toThrowError(expect.objectContaining({ code: 'MIME_MISMATCH' }))
    expect(() =>
      validateKnowledgeFile('guide.pdf', 'application/pdf', new Uint8Array([1])),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FILE_SIGNATURE' }))
  })

  it('rejects files over 10 MiB', () => {
    expect(() =>
      validateKnowledgeFile(
        'guide.txt',
        'text/plain',
        new Uint8Array(MAX_KNOWLEDGE_FILE_BYTES + 1),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }))
  })

  it('recognizes only the allowed extensions', () => {
    expect(knowledgeFileTypeForName('GUIDE.PDF')).toEqual(
      expect.objectContaining({ sourceType: 'PDF', extension: 'pdf' }),
    )
    expect(knowledgeFileTypeForName('guide.exe')).toBeNull()
  })

  it('stops reading an R2 object after 10 MiB', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_KNOWLEDGE_FILE_BYTES))
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })

    await expect(readKnowledgeFileBody(body)).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })
})

describe('knowledge file extraction', () => {
  it('decodes TXT and Markdown as strict UTF-8', async () => {
    await expect(extractKnowledgeText('TXT', new TextEncoder().encode('hello 世界'))).resolves.toBe(
      'hello 世界',
    )
    await expect(
      extractKnowledgeText('MARKDOWN', new Uint8Array([0xc3, 0x28])),
    ).rejects.toMatchObject({ code: 'INVALID_UTF8' })
  })

  it('extracts PDF text with unpdf', async () => {
    await expect(extractKnowledgeText('PDF', new TextEncoder().encode(minimalPdf()))).resolves.toBe(
      'Hello PDF',
    )
  })

  it('extracts DOCX raw text without enabling external file access', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText').mockResolvedValue({
      value: 'Docx text',
      messages: [],
    })

    await expect(
      extractKnowledgeText('DOCX', new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    ).resolves.toBe('Docx text')
    expect(extractRawText).toHaveBeenCalledWith({
      arrayBuffer: expect.any(ArrayBuffer),
      buffer: expect.any(Uint8Array),
    })
  })

  it('turns extractor errors into a safe permanent failure', async () => {
    vi.spyOn(mammoth, 'extractRawText').mockResolvedValue({
      value: '',
      messages: [{ type: 'error', message: 'private parser detail', error: new Error('detail') }],
    })

    await expect(
      extractKnowledgeText('DOCX', new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    ).rejects.toMatchObject({ code: 'FILE_EXTRACTION_FAILED' })
  })
})

function minimalPdf() {
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 72 712 Td (Hello PDF) Tj ET
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF`
}
