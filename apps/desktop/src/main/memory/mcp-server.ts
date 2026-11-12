import { randomBytes, timingSafeEqual } from 'crypto'
import { createServer } from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { asSchema } from 'ai'
import type { ToolSet } from 'ai'

/* ---- Memory tools over MCP ----
 * A provider with its own agent loop (Claude Code) cannot call AI SDK tools, so the same
 * tools are served to it over MCP: JSON-RPC on a loopback port, one server per request,
 * closed when the request ends. Only the tools' own code touches the disk, so every path
 * rule in `store.ts` still holds. A random bearer token keeps other local processes out.
 */

export const MEMORY_MCP_SERVER_NAME = 'delta-memory'

const PROTOCOL_VERSION = '2025-06-18'
const BODY_LIMIT = 4 * 1024 * 1024

export interface MemoryMcpServer {
  url: string
  token: string
  close: () => void
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > BODY_LIMIT) {
        reject(new Error('Request too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function listTools(tools: ToolSet): Promise<unknown[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name,
      description: tool.description ?? '',
      inputSchema: await asSchema(tool.inputSchema).jsonSchema
    }))
  )
}

async function callTool(tools: ToolSet, params: Record<string, unknown>): Promise<unknown> {
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined
  if (!tool?.execute) {
    return { content: [{ type: 'text', text: `Error: no tool named "${name}".` }], isError: true }
  }
  const validated = await asSchema(tool.inputSchema).validate?.(params.arguments ?? {})
  if (validated && !validated.success) {
    const text = `Error: invalid arguments: ${validated.error.message}`
    return { content: [{ type: 'text', text }], isError: true }
  }
  const input = validated ? validated.value : params.arguments
  const output = await tool.execute(input, { toolCallId: name, messages: [], context: {} })
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return { content: [{ type: 'text', text }], isError: text.startsWith('Error:') }
}

async function answer(tools: ToolSet, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  // A notification has no id and gets no reply.
  if (request.id === undefined) return null
  const id = request.id
  const params = request.params ?? {}
  try {
    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === 'string'
                ? params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: MEMORY_MCP_SERVER_NAME, version: '1.0.0' }
          }
        }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: await listTools(tools) } }
      case 'tools/call':
        return { jsonrpc: '2.0', id, result: await callTool(tools, params) }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { jsonrpc: '2.0', id, error: { code: -32603, message } }
  }
}

async function handle(
  tools: ToolSet,
  token: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!sameToken(req.headers.authorization, token)) {
    res.writeHead(401).end()
    return
  }
  if (req.method === 'DELETE') {
    res.writeHead(200).end()
    return
  }
  // No server-initiated stream: every reply goes back on its own POST.
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, DELETE' }).end()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    )
    return
  }
  const batch = Array.isArray(parsed)
  const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[]
  const replies = (await Promise.all(requests.map((request) => answer(tools, request)))).filter(
    (reply): reply is JsonRpcResponse => reply !== null
  )
  if (replies.length === 0) {
    res.writeHead(202).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(batch ? replies : replies[0]))
}

/** Serves `tools` on a fresh loopback port until `close`. */
export function startMemoryMcpServer(tools: ToolSet): Promise<MemoryMcpServer> {
  const token = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    handle(tools, token, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        close: () => {
          server.closeAllConnections()
          server.close()
        }
      })
    })
  })
}
