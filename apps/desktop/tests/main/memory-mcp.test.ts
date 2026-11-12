import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (): string => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/config', () => ({
  resolveRole: vi.fn(),
  RoleUnassignedError: class RoleUnassignedError extends Error {}
}))
vi.mock('../../src/main/services/model-catalog', () => ({ getCachedModel: vi.fn() }))

import { startMemoryMcpServer } from '../../src/main/memory/mcp-server'
import type { MemoryMcpServer } from '../../src/main/memory/mcp-server'
import { createMemoryTools } from '../../src/main/memory/tools'

let root: string
let server: MemoryMcpServer
let changes: number

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'delta-mcp-'))
  changes = 0
  server = await startMemoryMcpServer(createMemoryTools(root, () => (changes += 1)))
})

afterEach(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

async function rpc(
  body: unknown,
  token = server.token
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

function call(
  name: string,
  args: unknown,
  id = 1
): Promise<{ json: Record<string, unknown> | null }> {
  return rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
}

describe('memory MCP server', () => {
  it('refuses a request without its token', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')
    expect(status).toBe(401)
  })

  it('answers the handshake and lists the memory tools with JSON schemas', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    })
    expect(init.json?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} }
    })
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (json?.result as { tools: Array<{ name: string; inputSchema: object }> }).tools
    expect(tools.map((tool) => tool.name)).toContain('memory_write')
    expect(tools.find((tool) => tool.name === 'memory_cat')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } }
    })
  })

  it('runs the real tools inside the memory root and reports a change', async () => {
    await call('memory_write', { path: 'topics/bio.md', content: 'Krebs cycle' })
    expect(readFileSync(join(root, 'topics/bio.md'), 'utf8')).toBe('Krebs cycle')
    expect(changes).toBe(1)

    const { json } = await call('memory_cat', { path: 'topics/bio.md' }, 2)
    expect(json?.result).toEqual({
      content: [{ type: 'text', text: 'Krebs cycle' }],
      isError: false
    })
  })

  it('keeps the store rules: a path outside the root is refused as a tool error', async () => {
    const { json } = await call('memory_write', { path: '../escape.md', content: 'x' })
    expect(json?.result).toMatchObject({ isError: true })
    expect(changes).toBe(0)
  })

  it('refuses bad arguments and unknown tools or methods', async () => {
    expect((await call('memory_cat', { nope: 1 })).json?.result).toMatchObject({ isError: true })
    expect((await call('shell', {})).json?.result).toMatchObject({ isError: true })
    const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
    expect(json?.error).toMatchObject({ code: -32601 })
  })
})
