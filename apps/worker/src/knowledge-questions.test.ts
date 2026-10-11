import { normalizeQuestionAnswer, chunkKnowledgeText } from '@deepsales/db'
import { describe, expect, it } from 'vitest'

describe('structured knowledge boundary', () => {
  it('keeps a complete normalized question and answer in one retrievable chunk', () => {
    const pair = normalizeQuestionAnswer({
      question: '  How do I clean the lamp?\r\n',
      answer: ' Use a dry cloth.\u0000\r\nDisconnect power first. ',
    })
    expect(pair.question).toBe('How do I clean the lamp?')
    expect(pair.answer).toBe('Use a dry cloth.\nDisconnect power first.')
    expect(chunkKnowledgeText(pair.sourceText)).toEqual([
      'Question: How do I clean the lamp?\nAnswer: Use a dry cloth.\nDisconnect power first.',
    ])
    expect(() => normalizeQuestionAnswer({ question: ' ', answer: 'Yes' })).toThrow()
    expect(() => normalizeQuestionAnswer({ question: 'Why?', answer: 'x'.repeat(1501) })).toThrow()
    expect(() =>
      normalizeQuestionAnswer({ question: '💡'.repeat(400), answer: 'x'.repeat(1500) }),
    ).not.toThrow()
    expect(() => normalizeQuestionAnswer({ question: '💡'.repeat(401), answer: 'Yes' })).toThrow()
  })
})
