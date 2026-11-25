import { describe, expect, it } from 'vitest'

import { discoverConnectionModels } from '../../src/main/services/model-discovery'
import type { Connection } from '../../src/shared/models'

function connection(overrides: Partial<Connection> & Pick<Connection, 'providerType'>): Connection {
  return { id: 'conn_test', label: 'Test', apiKey: 'test-key', ...overrides } as Connection
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** Answers each request with the next page and records the URLs asked for. */
function pagedFetch(pages: Response[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    urls.push(String(input))
    return pages.shift() ?? new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, urls }
}

describe('discoverConnectionModels paging', () => {
  it('lists every Anthropic model, past the first page', async () => {
    const { fetchImpl, urls } = pagedFetch([
      json({ data: [{ id: 'claude-b' }, { id: 'claude-a' }], has_more: true, last_id: 'claude-a' }),
      json({ data: [{ id: 'claude-old' }], has_more: false, last_id: 'claude-old' })
    ])

    const result = await discoverConnectionModels(
      connection({ providerType: 'anthropic' }),
      fetchImpl
    )

    expect(result).toEqual({ models: ['claude-a', 'claude-b', 'claude-old'] })
    expect(urls).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a'
    ])
  })

  it('follows Google page tokens', async () => {
    const { fetchImpl, urls } = pagedFetch([
      json({
        models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }],
        nextPageToken: 'tok 2'
      }),
      json({
        models: [{ name: 'models/gemini-y', supportedGenerationMethods: ['generateContent'] }]
      })
    ])

    const result = await discoverConnectionModels(
      connection({ providerType: 'google-ai-studio' }),
      fetchImpl
    )

    expect(result.models).toEqual(['gemini-x', 'gemini-y'])
    expect(urls[1]).toContain('pageToken=tok+2')
    expect(urls).toHaveLength(2)
  })

  it('keeps the models already listed when a later page fails', async () => {
    const { fetchImpl } = pagedFetch([
      json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }),
      json({ error: 'overloaded' }, 529)
    ])

    const result = await discoverConnectionModels(
      connection({ providerType: 'anthropic' }),
      fetchImpl
    )

    expect(result).toEqual({ models: ['claude-a'] })
  })

  it('asks OpenAI-wire providers once, with no paging parameters', async () => {
    const { fetchImpl, urls } = pagedFetch([json({ data: [{ id: 'gpt-x' }], has_more: true })])

    const result = await discoverConnectionModels(
      connection({ providerType: 'openai-compatible', baseUrl: 'https://gw.test/v1' }),
      fetchImpl
    )

    expect(result.models).toEqual(['gpt-x'])
    expect(urls).toEqual(['https://gw.test/v1/models'])
  })
})
