import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasKeyboardActions } from '../src/canvas/useCanvasKeyboard'
import { handleKeyDown } from '../src/canvas/useCanvasKeyboard'

/** Every action is a spy, so a test only names the keys it cares about. */
function actionsWith(selected: string[] = []): CanvasKeyboardActions {
  const refs = {
    selectedRef: { current: new Set(selected) },
    linksRef: { current: [] },
    framesRef: { current: [] },
    viewportRef: { current: { x: 0, y: 0, zoom: 1 } },
    clearGesture: null,
    closeHelp: null,
    cancelPlacing: null,
    cancelDraft: null,
    resetTool: null
  }
  return new Proxy(refs as unknown as CanvasKeyboardActions, {
    get: (target, name, receiver) => {
      if (!(name in target)) Reflect.set(target, name, vi.fn(), receiver)
      return Reflect.get(target, name, receiver)
    }
  })
}

function press(
  key: string,
  actions: CanvasKeyboardActions,
  modifiers: { altKey?: boolean; shiftKey?: boolean } = {}
): KeyboardEvent {
  const e = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
    defaultPrevented: false,
    target: new (globalThis.Element as unknown as new () => Element)(),
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent
  handleKeyDown(e, actions)
  return e
}

describe('canvas keys', () => {
  beforeAll(() => {
    class FakeElement {
      closest(): null {
        return null
      }
    }
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('HTMLElement', FakeElement)
  })

  // Focus moves into a text field before the key has finished, so unless its default is
  // cancelled the letter is typed into that field.
  it.each([
    ['o', [], 'toggleOutline'],
    ['n', [], 'newSession'],
    ['a', ['card'], 'askAboutSelection'],
    ['Enter', [], 'compose']
  ] as const)('%s opens its text field without typing into it', (key, selected, action) => {
    const actions = actionsWith([...selected])
    const e = press(key, actions)
    expect(actions[action]).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('leaves a key alone when it is being typed into a field', () => {
    const actions = actionsWith()
    const field = new (globalThis.HTMLElement as unknown as new () => HTMLElement)()
    Object.assign(field, { isContentEditable: false, tagName: 'INPUT' })
    const e = {
      key: 'o',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: field,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent
    handleKeyDown(e, actions)
    expect(actions.toggleOutline).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('resizes the selection with Alt+Shift+arrows, and keeps Alt+arrows for the view history', () => {
    const actions = actionsWith(['card'])
    const e = press('ArrowRight', actions, { altKey: true, shiftKey: true })
    expect(actions.resizeSelection).toHaveBeenCalledWith('right')
    expect(e.preventDefault).toHaveBeenCalled()
    press('ArrowUp', actions, { altKey: true, shiftKey: true })
    expect(actions.resizeSelection).toHaveBeenLastCalledWith('top')
    press('ArrowLeft', actions, { altKey: true })
    expect(actions.travelViewHistory).toHaveBeenCalledWith('back')
    expect(actions.resizeSelection).toHaveBeenCalledTimes(2)
  })

  it('has nothing to resize with no selection', () => {
    const actions = actionsWith()
    const e = press('ArrowDown', actions, { altKey: true, shiftKey: true })
    expect(actions.resizeSelection).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves Escape to the IME while text is being composed', () => {
    const actions = actionsWith(['card'])
    const e = {
      key: 'Escape',
      isComposing: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: new (globalThis.Element as unknown as new () => Element)(),
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent
    handleKeyDown(e, actions)
    expect(actions.clearSelection).not.toHaveBeenCalled()
    press('Escape', actions)
    expect(actions.clearSelection).toHaveBeenCalledOnce()
  })
})
