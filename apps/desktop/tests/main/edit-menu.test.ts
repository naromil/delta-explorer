import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() } }))

import { editMenuTemplate } from '../../src/main/edit-menu'
import type { EditMenuParams } from '../../src/main/edit-menu'

const allowed = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false
}

function params(overrides: Partial<EditMenuParams> = {}): EditMenuParams {
  return {
    isEditable: true,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: allowed,
    ...overrides
  }
}

function actions(): {
  replaceMisspelling: ReturnType<typeof vi.fn>
  addToDictionary: ReturnType<typeof vi.fn>
} {
  return { replaceMisspelling: vi.fn(), addToDictionary: vi.fn() }
}

describe('editMenuTemplate', () => {
  it('gives no menu outside a text field', () => {
    expect(editMenuTemplate(params({ isEditable: false }), actions())).toEqual([])
  })

  it('offers cut, copy, paste and select all in a field', () => {
    const roles = editMenuTemplate(params(), actions()).map((item) => item.role ?? item.type)
    expect(roles).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
  })

  it('disables what the field cannot do', () => {
    const template = editMenuTemplate(
      params({ editFlags: { ...allowed, canCut: false, canCopy: false } }),
      actions()
    )
    const enabled = Object.fromEntries(template.map((item) => [item.role, item.enabled]))
    expect(enabled).toMatchObject({ cut: false, copy: false, paste: true, selectAll: true })
  })

  it('puts spelling suggestions first and replaces the word with the chosen one', () => {
    const act = actions()
    const template = editMenuTemplate(
      params({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] }),
      act
    )
    expect(template.slice(0, 3).map((item) => item.label)).toEqual([
      'the',
      'tech',
      'Add to Dictionary'
    ])
    template[1].click?.({} as never, undefined, {} as never)
    expect(act.replaceMisspelling).toHaveBeenCalledWith('tech')
    template[2].click?.({} as never, undefined, {} as never)
    expect(act.addToDictionary).toHaveBeenCalledWith('teh')
  })

  it('caps the suggestions and says when there are none', () => {
    const many = editMenuTemplate(
      params({ misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
      actions()
    )
    expect(many.filter((item) => item.click && item.label !== 'Add to Dictionary')).toHaveLength(5)

    const none = editMenuTemplate(params({ misspelledWord: 'zzxq' }), actions())
    expect(none[0]).toMatchObject({ label: 'No suggestions', enabled: false })
  })
})
