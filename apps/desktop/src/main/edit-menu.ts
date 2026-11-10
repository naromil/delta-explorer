import { Menu } from 'electron'
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type EditMenuParams = Pick<
  ContextMenuParams,
  'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>

export interface EditMenuActions {
  replaceMisspelling: (word: string) => void
  addToDictionary: (word: string) => void
}

/** Spelling suggestions shown at the top of the menu. */
const MAX_SUGGESTIONS = 5

/**
 * The menu for a right click in a text field: spelling first, then Cut/Copy/Paste and
 * Select All. Anything that is not a field gets no menu (empty list), so the renderer's own
 * menus stay the only ones elsewhere.
 */
export function editMenuTemplate(
  params: EditMenuParams,
  actions: EditMenuActions
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return []
  const items: MenuItemConstructorOptions[] = []
  const word = params.misspelledWord
  if (word) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) })
    }
    if (suggestions.length === 0) items.push({ label: 'No suggestions', enabled: false })
    items.push(
      { label: 'Add to Dictionary', click: () => actions.addToDictionary(word) },
      { type: 'separator' }
    )
  }
  const flags = params.editFlags
  items.push(
    { role: 'cut', enabled: flags.canCut },
    { role: 'copy', enabled: flags.canCopy },
    { role: 'paste', enabled: flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: flags.canSelectAll }
  )
  return items
}

/** Electron shows no menu by default; a field the renderer leaves alone gets this one. */
export function installEditMenu(window: BrowserWindow): void {
  const contents = window.webContents
  contents.on('context-menu', (_event, params) => {
    const template = editMenuTemplate(params, {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word)
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window })
  })
}
