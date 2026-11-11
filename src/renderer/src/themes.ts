import type { Theme } from '../../shared/types'
import light from './themes/light.json'
import dark from './themes/dark.json'
import sepia from './themes/sepia.json'
import solarized from './themes/solarized-dark.json'

export const BUILT_IN: Theme[] = [light, dark, sepia, solarized]

/** Each theme color becomes a CSS variable (--bg, --text, --syn-command, …) used by the whole UI and the editor. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style
  const base = theme.dark ? dark : light // fill any keys a user theme leaves out
  for (const [k, v] of Object.entries({ ...base.colors, ...theme.colors })) root.setProperty(`--${k}`, v)
  for (const [k, v] of Object.entries({ ...base.syntax, ...theme.syntax })) root.setProperty(`--syn-${k}`, v)
  document.documentElement.dataset.dark = String(theme.dark)
}
