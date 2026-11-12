import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { delimiter, join } from 'path'
import type { ToolSet } from 'ai'
import type { ProviderMessage } from '@delta/core/messages'
import { MEMORY_MCP_SERVER_NAME, startMemoryMcpServer } from '../memory/mcp-server'
import type { MemoryMcpServer } from '../memory/mcp-server'

/* ---- Claude Code headless provider ----
 * Runs `claude -p` and reads its stream-json output. The request may carry untrusted
 * screen text, so the CLI gets none of its own tools, no MCP servers but ours and no
 * settings (which would load the user's hooks), and runs in a temporary directory so it
 * reads no CLAUDE.md. Application tools reach it over MCP (`memory/mcp-server.ts`).
 */

const IDLE_TIMEOUT_MS = 120_000
const CANCEL_MESSAGE = 'Generation stopped.'
const STDERR_LIMIT = 500

/** Application tools for one run, and the tool steps it may take. */
export interface ClaudeCodeTools {
  tools: ToolSet
  maxSteps: number
}

/** A desktop launch often lacks the shell's PATH, so the usual install spots are tried too. */
function commandCandidates(configured: string | undefined): string[] {
  const command = configured?.trim()
  if (command) return [command]
  const home = homedir()
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const dirs = [...fromPath, join(home, '.local', 'bin'), join(home, '.claude', 'local')]
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)))
}

export function resolveClaudeCommand(configured: string | undefined): string | null {
  const candidates = commandCandidates(configured)
  if (configured?.trim()) return candidates[0]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** System messages become the system prompt; the rest is one transcript ending in the question. */
export function claudeCodePrompt(messages: ProviderMessage[]): {
  system: string
  prompt: string
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const turns = messages.filter((message) => message.role !== 'system')
  const last = turns[turns.length - 1]
  const history = turns.slice(0, -1)
  if (history.length === 0) return { system, prompt: last?.content ?? '' }
  const transcript = history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
  return {
    system,
    prompt:
      `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\n` +
      `Reply to the user's newest message:\n\n${last?.content ?? ''}`
  }
}

export function claudeCodeArgs(model: string, system: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence'
  ]
  if (model.trim()) args.push('--model', model.trim())
  if (system) args.push('--system-prompt', system)
  return args
}

/** Claude Code's name for one of our tools served over MCP. */
export function claudeCodeToolName(name: string): string {
  return `mcp__${MEMORY_MCP_SERVER_NAME}__${name}`
}

/** Points the CLI at our server and allows exactly its tools; nothing else is reachable. */
export function claudeCodeMcpArgs(
  server: Pick<MemoryMcpServer, 'url' | 'token'>,
  tools: ClaudeCodeTools
): string[] {
  const config = {
    mcpServers: {
      [MEMORY_MCP_SERVER_NAME]: {
        type: 'http',
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` }
      }
    }
  }
  return [
    '--mcp-config',
    JSON.stringify(config),
    // A headless run refuses any tool not allowed up front.
    '--allowedTools',
    Object.keys(tools.tools).map(claudeCodeToolName).join(','),
    '--max-turns',
    String(tools.maxSteps)
  ]
}

export interface ClaudeCodeEvent {
  text?: string
  /** Ends the stream with this message. */
  error?: string
  /** A new model message begins: its text must not run into the last one's. */
  step?: boolean
  /** The turn limit was reached, which is only a failure when nothing was answered. */
  outOfTurns?: boolean
}

/** Reads one stream-json line. */
export function readClaudeCodeEvent(line: string): ClaudeCodeEvent {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return {}
  }
  if (typeof event !== 'object' || event === null) return {}
  const record = event as Record<string, unknown>
  if (record.type === 'stream_event') {
    const inner = record.event as Record<string, unknown> | undefined
    const delta = inner?.delta as Record<string, unknown> | undefined
    if (inner?.type === 'message_start') return { step: true }
    if (inner?.type === 'content_block_delta' && delta?.type === 'text_delta') {
      return typeof delta.text === 'string' ? { text: delta.text } : {}
    }
    return {}
  }
  if (record.type === 'result' && record.subtype === 'error_max_turns') {
    return { error: 'Claude Code used all its turns without answering.', outOfTurns: true }
  }
  if (record.type === 'result' && record.is_error === true) {
    const detail = typeof record.result === 'string' && record.result ? record.result : 'failed'
    return { error: `Claude Code: ${detail}` }
  }
  return {}
}

/** One CLI run, its text streamed as it arrives. */
async function* runClaudeCode(
  executable: string,
  args: string[],
  prompt: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const child = spawn(executable, args, {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  const queue: string[] = []
  let failure: Error | null = null
  let finished = false
  let wake: (() => void) | null = null
  let buffer = ''
  let stderr = ''
  let answered = false
  let stepEnded = false
  let endedOutOfTurns = false
  let timer: NodeJS.Timeout | undefined

  const notify = (): void => {
    wake?.()
    wake = null
  }
  const fail = (error: Error): void => {
    if (!failure) failure = error
    child.kill()
    notify()
  }
  const armTimeout = (): void => {
    clearTimeout(timer)
    timer = setTimeout(
      () => fail(new Error(`Claude Code produced nothing for ${IDLE_TIMEOUT_MS / 1000}s.`)),
      IDLE_TIMEOUT_MS
    )
  }
  const onAbort = (): void => fail(new Error(CANCEL_MESSAGE))
  const readLine = (line: string): void => {
    const { text, error, step, outOfTurns } = readClaudeCodeEvent(line)
    if (outOfTurns && answered) {
      endedOutOfTurns = true
    } else if (error) {
      fail(new Error(error))
    } else if (step) {
      stepEnded = true
    } else if (text) {
      // Text from separate tool steps must not run together in one answer.
      if (answered && stepEnded) queue.push('\n\n')
      answered = true
      stepEnded = false
      queue.push(text)
    }
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  armTimeout()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data: string) => {
    armTimeout()
    buffer += data
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(readLine)
    notify()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (data: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += data
  })
  child.on('error', (err) => fail(new Error(`Could not start Claude Code: ${err.message}`)))
  child.on('close', (code) => {
    if (buffer.trim()) readLine(buffer)
    if (code !== 0 && !failure && !endedOutOfTurns) {
      const detail = stderr.trim().slice(0, STDERR_LIMIT)
      failure = new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}`)
    }
    finished = true
    notify()
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as string
        continue
      }
      if (failure) throw failure
      if (finished) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (!finished) child.kill()
  }
}

/** Streams an answer; with `tools`, they are served over MCP for the length of the run. */
export async function* streamClaudeCode(
  command: string | undefined,
  model: string,
  messages: ProviderMessage[],
  signal?: AbortSignal,
  tools?: ClaudeCodeTools
): AsyncGenerator<string> {
  const executable = resolveClaudeCommand(command)
  if (!executable) {
    throw new Error(
      'Claude Code was not found. Install it, or set its path on the connection in Settings → Models.'
    )
  }
  if (signal?.aborted) throw new Error(CANCEL_MESSAGE)

  const { system, prompt } = claudeCodePrompt(messages)
  const server = tools ? await startMemoryMcpServer(tools.tools) : null
  try {
    const args = [
      ...claudeCodeArgs(model, system),
      ...(server && tools ? claudeCodeMcpArgs(server, tools) : [])
    ]
    yield* runClaudeCode(executable, args, prompt, signal)
  } finally {
    server?.close()
  }
}

/** `claude --version`, for the connection's Test button. */
export function probeClaudeCode(command: string | undefined): Promise<{
  ok: boolean
  detail: string
}> {
  const executable = resolveClaudeCommand(command)
  if (!executable) return Promise.resolve({ ok: false, detail: 'Claude Code was not found' })
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], { cwd: tmpdir(), windowsHide: true })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, detail: 'Claude Code did not answer --version' })
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => (output += data))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, detail: output.trim() || 'Claude Code is installed' }
          : { ok: false, detail: `claude --version exited with code ${code}` }
      )
    })
  })
}
