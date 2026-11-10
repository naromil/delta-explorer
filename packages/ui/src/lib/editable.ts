/** Inputs that hold no text, so a right click on them has nothing to edit. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/**
 * Whether a right click landed in a text field. Such a click is left to the main process's
 * native edit menu (Cut/Copy/Paste, spelling), so the app's own menus must not claim it.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const field = (target as Element).closest('input, textarea, [contenteditable]')
  if (!field) return false
  if (field.tagName === 'INPUT') {
    return !NON_TEXT_INPUTS.has(((field as HTMLInputElement).type || 'text').toLowerCase())
  }
  if (field.tagName === 'TEXTAREA') return true
  return field.getAttribute('contenteditable') !== 'false'
}
