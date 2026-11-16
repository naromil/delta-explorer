import { describe, expect, it } from 'vitest'
import { createDefaultModelConfig, hasNoConnections } from '../../src/shared/models'

describe('hasNoConnections', () => {
  it('is true for a fresh install', () => {
    expect(hasNoConnections(createDefaultModelConfig())).toBe(true)
  })

  it('is false once any connection exists, with or without a key', () => {
    const config = createDefaultModelConfig()
    config.connections.local = { id: 'local', label: 'Ollama', providerType: 'ollama' }
    expect(hasNoConnections(config)).toBe(false)
  })

  it('treats anything unreadable as configured, so startup never redirects by mistake', () => {
    expect(hasNoConnections(null)).toBe(false)
    expect(hasNoConnections(undefined)).toBe(false)
    expect(hasNoConnections('nope')).toBe(false)
    expect(hasNoConnections({})).toBe(false)
    expect(hasNoConnections({ connections: [] })).toBe(false)
    expect(hasNoConnections({ connections: null })).toBe(false)
  })
})
