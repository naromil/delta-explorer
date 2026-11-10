import { describe, expect, it } from 'vitest'
import { isEditableTarget } from '../../src/renderer/src/lib/editable'

function fakeField(tagName: string, attributes: Record<string, string> = {}): EventTarget {
  const field = {
    tagName,
    type: attributes.type ?? '',
    getAttribute: (name: string) => attributes[name] ?? null
  }
  return { closest: () => field } as unknown as EventTarget
}

describe('isEditableTarget', () => {
  it('accepts text inputs, textareas and editable content', () => {
    expect(isEditableTarget(fakeField('INPUT', { type: 'text' }))).toBe(true)
    expect(isEditableTarget(fakeField('INPUT', { type: 'search' }))).toBe(true)
    expect(isEditableTarget(fakeField('INPUT'))).toBe(true)
    expect(isEditableTarget(fakeField('TEXTAREA'))).toBe(true)
    expect(isEditableTarget(fakeField('DIV', { contenteditable: 'true' }))).toBe(true)
  })

  it('refuses inputs without text and switched-off editable content', () => {
    expect(isEditableTarget(fakeField('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isEditableTarget(fakeField('INPUT', { type: 'range' }))).toBe(false)
    expect(isEditableTarget(fakeField('DIV', { contenteditable: 'false' }))).toBe(false)
  })

  it('refuses anything outside a field', () => {
    expect(isEditableTarget({ closest: () => null } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget({} as EventTarget)).toBe(false)
  })
})
