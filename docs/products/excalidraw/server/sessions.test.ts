import { describe, expect, test } from 'bun:test'
import { loadServerConfig } from './sessions.ts'

describe('loadServerConfig', () => {
  test('defaults to kimi-k3', () => {
    expect(loadServerConfig({}).defaultModel).toEqual({ providerID: 'Yd-KiMi', modelID: 'kimi-k3' })
  })

  test('keeps the model override configurable', () => {
    expect(loadServerConfig({ OPENCODE_SAAS_MODEL: 'opencode/big-pickle' }).defaultModel).toEqual({
      providerID: 'opencode',
      modelID: 'big-pickle',
    })
  })
})
