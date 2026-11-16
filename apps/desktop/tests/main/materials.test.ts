import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { settings } = vi.hoisted(() => ({ settings: { materialsDir: '' } }))

vi.mock('../../src/main/config', () => ({
  loadAppSettings: () => settings,
  resolveRole: () => ({ connection: { providerType: 'openai', apiKey: 'k' }, model: 'm' }),
  RoleUnassignedError: class RoleUnassignedError extends Error {}
}))
// The real renderer is a hidden Electron window; the tools take a stand-in.
vi.mock('../../src/main/materials/render', () => ({ renderMaterial: vi.fn() }))

import {
  countMaterial,
  findMaterials,
  grepMaterials,
  listMaterials,
  MAX_READ_CHARS,
  readMaterial,
  resolveMaterialsRoot
} from '../../src/main/materials/store'
import { createMaterialsTools, withMaterials } from '../../src/main/materials/tools'
import type { MaterialRenderer } from '../../src/main/materials/tools'
import { callProvider, withToolImages } from '../../src/main/provider'
import type { AgentTools } from '../../src/main/provider'
import { TOOL_IMAGES_NOTE } from '@delta/core/prompts'
import type { ImageInput } from '@delta/core/messages'

let base: string
let root: string

function run(
  tools: ReturnType<typeof createMaterialsTools>,
  name: string,
  input: unknown
): unknown {
  const execute = tools[name].execute as (input: unknown, options: unknown) => unknown
  return execute(input, { toolCallId: 't', messages: [] })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delta-materials-'))
  root = join(base, 'materials')
  mkdirSync(join(root, 'calculus', 'week-1', 'deep'), { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'README.md'), 'Course overview\nSecond line')
  writeFileSync(
    join(root, 'calculus', 'limits.md'),
    'A limit is a value.\nEpsilon-Delta definition'
  )
  writeFileSync(join(root, 'calculus', 'week-1', 'deep', 'proof.txt'), 'delta proof')
  writeFileSync(join(root, 'calculus', 'slides.pdf'), Buffer.from([37, 80, 68, 70, 0, 1, 2]))
  writeFileSync(join(root, '.git', 'config'), 'delta secret')
  writeFileSync(join(root, '.env'), 'KEY=delta')
  writeFileSync(join(base, 'outside.md'), 'delta outside')
  settings.materialsDir = root
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('listMaterials', () => {
  it('lists to a depth, with sizes, and marks what it did not open', () => {
    const listing = listMaterials(root, '.', 2)
    expect(listing).toContain('README.md (27 B)')
    expect(listing).toContain('calculus/limits.md')
    expect(listing).toContain('calculus/week-1/ …')
    expect(listing).not.toContain('proof.txt')
    expect(listMaterials(root, '.', 8)).toContain('calculus/week-1/deep/proof.txt')
  })

  it('hides dotfiles and truncates a long listing', () => {
    expect(listMaterials(root, '.', 8)).not.toMatch(/\.git|\.env/)
    expect(listMaterials(root, '.', 8, 2).split('\n')).toHaveLength(3)
  })
})

describe('readMaterial', () => {
  it('reads a text file and refuses a binary one', async () => {
    expect(await readMaterial(root, 'calculus/limits.md')).toBe(
      'A limit is a value.\nEpsilon-Delta definition'
    )
    await expect(readMaterial(root, 'calculus/slides.pdf')).rejects.toThrow(/materials_view/)
    writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 0, 2]))
    await expect(readMaterial(root, 'blob.bin')).rejects.toThrow(/not a text file/)
  })

  it('pages a long file by line', async () => {
    const line = 'x'.repeat(999)
    writeFileSync(join(root, 'long.txt'), Array.from({ length: 60 }, () => line).join('\n'))
    const first = await readMaterial(root, 'long.txt')
    expect(first.length).toBeLessThan(MAX_READ_CHARS + 200)
    expect(first).toMatch(/… lines 1-24 of 60; continue with start_line 25$/)
    expect(await readMaterial(root, 'long.txt', 49)).toMatch(/… lines 49-60 of 60$/)
    await expect(readMaterial(root, 'long.txt', 61)).rejects.toThrow(/only 60 lines/)
    expect(await readMaterial(root, 'long.txt', 3, 2)).toMatch(
      /… lines 3-4 of 60; continue with start_line 5$/
    )
  })

  it('never leaves the folder', async () => {
    symlinkSync(join(base, 'outside.md'), join(root, 'link.md'))
    symlinkSync(base, join(root, 'up'))
    for (const path of ['../outside.md', join(base, 'outside.md'), 'link.md', 'up/outside.md']) {
      await expect(readMaterial(root, path)).rejects.toThrow(/Invalid path/)
    }
    await expect(readMaterial(root, '.git/config')).rejects.toThrow(/No such file/)
    await expect(readMaterial(root, '.env')).rejects.toThrow(/No such file/)
    expect(listMaterials(root, '.', 8)).not.toMatch(/link\.md|up\//)
  })
})

describe('grepMaterials', () => {
  it('finds literal text case-insensitively, skipping hidden and binary files', async () => {
    symlinkSync(join(base, 'outside.md'), join(root, 'link.md'))
    expect((await grepMaterials(root, 'DELTA')).split('\n')).toEqual([
      'calculus/limits.md:2: Epsilon-Delta definition',
      'calculus/week-1/deep/proof.txt:1: delta proof'
    ])
    expect(await grepMaterials(root, 'delta', 'calculus/limits.md')).toBe(
      'calculus/limits.md:2: Epsilon-Delta definition'
    )
    expect(await grepMaterials(root, 'nothing here')).toBe('(no matches)')
    await expect(grepMaterials(root, ' ')).rejects.toThrow(/must not be empty/)
  })
})

describe('findMaterials and countMaterial', () => {
  it('matches names by glob, and paths when the glob has a slash', () => {
    expect(findMaterials(root, '*.PDF')).toBe('calculus/slides.pdf (7 B)')
    expect(findMaterials(root, 'week-?')).toBe('calculus/week-1/')
    expect(findMaterials(root, 'calculus/**/*.txt')).toBe('calculus/week-1/deep/proof.txt (11 B)')
    expect(findMaterials(root, 'calculus/*.txt')).toBe('(no matches)')
    expect(findMaterials(root, '*config*')).toBe('(no matches)')
    expect(findMaterials(root, '(a+)+$')).toBe('(no matches)')
    expect(() => findMaterials(root, '*', '../')).toThrow(/Invalid path/)
  })

  it('counts a text file', async () => {
    expect(await countMaterial(root, 'README.md')).toBe(
      'README.md: 2 lines, 4 words, 27 characters'
    )
  })
})

describe('resolveMaterialsRoot', () => {
  it('needs an existing directory', () => {
    expect(resolveMaterialsRoot('')).toBeNull()
    expect(resolveMaterialsRoot(join(base, 'missing'))).toBeNull()
    expect(resolveMaterialsRoot(join(base, 'outside.md'))).toBeNull()
    expect(resolveMaterialsRoot(root)).not.toBeNull()
  })
})

describe('withMaterials', () => {
  const agent: AgentTools = { tools: {}, instructions: 'memory rules', maxSteps: 10 }

  it('adds read-only tools, the layout and room to explore', () => {
    const extended = withMaterials(agent, 'yes')
    expect(Object.keys(extended?.tools ?? {})).toEqual([
      'materials_ls',
      'materials_find',
      'materials_cat',
      'materials_wc',
      'materials_grep',
      'materials_view'
    ])
    expect(extended?.instructions).toMatch(/^memory rules\n\n/)
    expect(extended?.instructions).toContain('calculus/limits.md')
    expect(extended?.maxSteps).toBe(16)
  })

  it('leaves the agent alone without a usable folder or without tools', () => {
    expect(withMaterials(undefined, 'yes')).toBeUndefined()
    settings.materialsDir = join(base, 'missing')
    expect(withMaterials(agent, 'yes')).toBe(agent)
    settings.materialsDir = ''
    expect(withMaterials(agent, 'yes')).toBe(agent)
  })

  it('reports a refusal to the model as a tool result and changes nothing on disk', async () => {
    const tools = createMaterialsTools(root, { images: true, toolImages: new Map() })
    const before = readdirSync(root, { recursive: true })
    expect(
      await run(tools, 'materials_cat', { path: '../outside.md', start_line: 1, line_count: 9 })
    ).toMatch(/^Error: Invalid/)
    expect(await run(tools, 'materials_grep', { text: 'limit', path: '.' })).toContain(
      'limits.md:1'
    )
    expect(await run(tools, 'materials_ls', { path: 'calculus', depth: 2 })).toContain(
      'calculus/week-1/'
    )
    expect(readdirSync(root, { recursive: true })).toEqual(before)
  })
})

describe('materials_view', () => {
  const render: MaterialRenderer = async (file, firstPage, lastPage, images) => ({
    pageCount: file.kind === 'pdf' ? 9 : 1,
    pages: Array.from({ length: Math.min(lastPage, 9) - firstPage + 1 }, (_, index) => ({
      page: firstPage + index,
      text: file.kind === 'pdf' ? `text of page ${firstPage + index}` : '',
      ...(images && { image: `IMG${firstPage + index}` })
    }))
  })
  const view = (
    tools: ReturnType<typeof createMaterialsTools>,
    id: string,
    input: { path: string; first_page: number; last_page: number }
  ): Promise<string> =>
    (tools.materials_view.execute as (input: unknown, options: unknown) => Promise<string>)(input, {
      toolCallId: id,
      messages: []
    })

  beforeEach(() => {
    writeFileSync(join(root, 'diagram.PNG'), Buffer.from([137, 80, 78, 71, 0]))
  })

  it('returns page text and hands the pictures to the request, four pages at a time', async () => {
    const toolImages = new Map<string, ImageInput[]>()
    const tools = createMaterialsTools(root, { images: true, toolImages, render })
    const result = await view(tools, 'a', {
      path: 'calculus/slides.pdf',
      first_page: 2,
      last_page: 9
    })
    expect(result).toMatch(/^calculus\/slides\.pdf: pages 2-5 of 9\. The pictures are attached/)
    expect(result).toContain('--- Page 5 text ---\ntext of page 5')
    expect(result).not.toContain('IMG')
    expect(toolImages.get('a')).toEqual(
      [2, 3, 4, 5].map((page) => ({ mediaType: 'image/jpeg', data: `IMG${page}` }))
    )
    expect(await view(tools, 'b', { path: 'diagram.PNG', first_page: 1, last_page: 1 })).toMatch(
      /^diagram\.PNG: The pictures are attached/
    )
    expect(toolImages.get('b')).toHaveLength(1)
  })

  it('stops attaching pictures once the request holds twelve', async () => {
    const toolImages = new Map<string, ImageInput[]>()
    const tools = createMaterialsTools(root, { images: true, toolImages, render })
    for (const id of ['a', 'b', 'c']) {
      await view(tools, id, { path: 'calculus/slides.pdf', first_page: 1, last_page: 4 })
    }
    const result = await view(tools, 'd', {
      path: 'calculus/slides.pdf',
      first_page: 5,
      last_page: 5
    })
    expect(result).toContain('No more pictures')
    expect(result).toContain('text of page 5')
    expect(toolImages.has('d')).toBe(false)
  })

  it('gives a model without vision the text only, and refuses other files', async () => {
    const toolImages = new Map<string, ImageInput[]>()
    const tools = createMaterialsTools(root, { images: false, toolImages, render })
    const pdf = await view(tools, 'a', { path: 'calculus/slides.pdf', first_page: 1, last_page: 1 })
    expect(pdf).toContain('cannot read images')
    expect(pdf).toContain('text of page 1')
    expect(await view(tools, 'b', { path: 'diagram.PNG', first_page: 1, last_page: 1 })).toContain(
      'cannot read images'
    )
    expect(toolImages.size).toBe(0)
    expect(await view(tools, 'c', { path: 'README.md', first_page: 1, last_page: 1 })).toMatch(
      /^Error: README\.md is not a PDF/
    )
    expect(await view(tools, 'd', { path: '../x.pdf', first_page: 1, last_page: 1 })).toMatch(
      /^Error: Invalid path/
    )
  })

  it('shows the pictures to the model in the step after the tool call', async () => {
    const toolImages = new Map<string, ImageInput[]>()
    const agent: AgentTools = {
      tools: createMaterialsTools(root, { images: true, toolImages, render }),
      instructions: 'rules',
      maxSteps: 5,
      toolImages
    }
    type Body = { messages: Array<{ role: string; content: unknown }> }
    const bodies: Body[] = []
    const sse = (frames: unknown[]): Response =>
      new Response(
        [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(
          ''
        ),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    const call = (id: string, page: number): Response =>
      sse([
        {
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id,
                    type: 'function',
                    function: {
                      name: 'materials_view',
                      arguments: JSON.stringify({
                        path: 'calculus/slides.pdf',
                        first_page: page,
                        last_page: page
                      })
                    }
                  }
                ]
              }
            }
          ]
        }
      ])
    const replies = [
      () => call('call_a', 1),
      () => call('call_b', 2),
      () => sse([{ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }])
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as Body)
        return replies[bodies.length - 1]()
      })
    )

    const answer = await callProvider(
      [{ role: 'user', content: 'what is on the slides?' }],
      'chat',
      undefined,
      agent
    )
    vi.unstubAllGlobals()

    expect(answer).toBe('done')
    const roles = (body: Body): string[] => body.messages.map((message) => message.role)
    expect(roles(bodies[1])).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(roles(bodies[2])).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
      'tool',
      'user'
    ])
    const pictures = bodies[2].messages[4].content as Array<Record<string, unknown>>
    expect(pictures[0]).toEqual({ type: 'text', text: TOOL_IMAGES_NOTE })
    expect(JSON.stringify(pictures[1])).toContain('data:image/jpeg;base64,IMG1')
    expect(JSON.stringify(bodies[2].messages[7])).toContain('IMG2')
    // The earlier steps are sent again unchanged, which is what a prompt cache reuses.
    expect(bodies[2].messages.slice(0, 5)).toEqual(bodies[1].messages)
  })

  it('does not attach the same pictures twice', () => {
    const toolImages = new Map([['a', [{ mediaType: 'image/jpeg', data: 'IMG' }]]])
    const toolMessage = {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'a',
          toolName: 'materials_view',
          output: { type: 'text' as const, value: 'x' }
        }
      ]
    }
    const once = withToolImages([toolMessage], toolImages)
    expect(once).toHaveLength(2)
    expect(withToolImages(once, toolImages)).toEqual(once)
  })
})
