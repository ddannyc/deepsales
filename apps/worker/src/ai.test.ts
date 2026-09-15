import { describe, expect, it } from 'vitest'
import { ALIBABA_LLM_PROVIDER, DEFAULT_LLM_MODEL, isLlmProviderConfigurationUsable } from './ai'

describe('LLM provider configuration', () => {
  it('requires the configured Alibaba provider, model, URL, and key', () => {
    const config = {
      apiKey: 'test-key',
      baseUrl: 'https://ai.example.test/v1',
      provider: ALIBABA_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
    }
    expect(isLlmProviderConfigurationUsable(config)).toBe(true)
    expect(isLlmProviderConfigurationUsable({ ...config, apiKey: ' ' })).toBe(false)
    expect(isLlmProviderConfigurationUsable({ ...config, provider: 'openai' })).toBe(false)
    expect(isLlmProviderConfigurationUsable({ ...config, model: 'other-model' })).toBe(false)
  })
})
