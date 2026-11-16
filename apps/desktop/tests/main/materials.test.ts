import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { settings } = vi.hoisted(() => ({ settings: { materialsDir: '' } }))

vi.mock('../../src/main/config', () => ({ loadAppSettings: () => settings }))

import {
  grepMaterials,
  listMaterials,
  MAX_READ_CHARS,
  readMaterial,
  resolveMaterialsRoot
} from '../../src/main/materials/store'
import { createMaterialsTools, withMaterials } from '../../src/main/materials/tools'
import type { AgentTools } from '../../src/main/provider'

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
    await expect(readMaterial(root, 'calculus/slides.pdf')).rejects.toThrow(/not a text file/)
  })

  it('pages a long file by line', async () => {
    const line = 'x'.repeat(999)
    writeFileSync(join(root, 'long.txt'), Array.from({ length: 60 }, () => line).join('\n'))
    const first = await readMaterial(root, 'long.txt')
    expect(first.length).toBeLessThan(MAX_READ_CHARS + 200)
    expect(first).toMatch(/… lines 1-24 of 60; continue with start_line 25$/)
    expect(await readMaterial(root, 'long.txt', 49)).toMatch(/… lines 49-60 of 60$/)
    await expect(readMaterial(root, 'long.txt', 61)).rejects.toThrow(/only 60 lines/)
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
    const extended = withMaterials(agent)
    expect(Object.keys(extended?.tools ?? {})).toEqual([
      'materials_ls',
      'materials_cat',
      'materials_grep'
    ])
    expect(extended?.instructions).toMatch(/^memory rules\n\n/)
    expect(extended?.instructions).toContain('calculus/limits.md')
    expect(extended?.maxSteps).toBe(16)
  })

  it('leaves the agent alone without a usable folder or without tools', () => {
    expect(withMaterials(undefined)).toBeUndefined()
    settings.materialsDir = join(base, 'missing')
    expect(withMaterials(agent)).toBe(agent)
    settings.materialsDir = ''
    expect(withMaterials(agent)).toBe(agent)
  })

  it('reports a refusal to the model as a tool result and changes nothing on disk', async () => {
    const tools = createMaterialsTools(root)
    const before = readdirSync(root, { recursive: true })
    expect(await run(tools, 'materials_cat', { path: '../outside.md', start_line: 1 })).toMatch(
      /^Error: Invalid/
    )
    expect(await run(tools, 'materials_grep', { text: 'limit', path: '.' })).toContain(
      'limits.md:1'
    )
    expect(await run(tools, 'materials_ls', { path: 'calculus', depth: 2 })).toContain(
      'calculus/week-1/'
    )
    expect(readdirSync(root, { recursive: true })).toEqual(before)
  })
})
