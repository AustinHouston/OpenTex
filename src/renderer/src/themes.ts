import type { Theme } from '../../shared/types'
import light from './themes/light.json'
import dark from './themes/dark.json'
import sepia from './themes/sepia.json'
import solarized from './themes/solarized-dark.json'
import paper from './themes/paper.json'
import ocean from './themes/ocean.json'
import rose from './themes/rose.json'
import lavender from './themes/lavender.json'
import midnight from './themes/midnight.json'
import forest from './themes/forest.json'
import ember from './themes/ember.json'
import highContrast from './themes/high-contrast.json'

export const BUILT_IN: Theme[] = [light, paper, sepia, ocean, rose, lavender, dark, midnight, forest, ember, solarized, highContrast]

/** Each theme color becomes a CSS variable (--bg, --text, --syn-command, …) used by the whole UI and the editor. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style
  const base = theme.dark ? dark : light // fill any keys a user theme leaves out
  for (const [k, v] of Object.entries({ ...base.colors, ...theme.colors })) root.setProperty(`--${k}`, v)
  for (const [k, v] of Object.entries({ ...base.syntax, ...theme.syntax })) root.setProperty(`--syn-${k}`, v)
  document.documentElement.dataset.dark = String(theme.dark)
}

/** A tiny picture of the app drawn in the theme's colors, used by the theme picker. */
export function themePreview(t: Theme): string {
  const c = { ...(t.dark ? dark : light).colors, ...t.colors }
  const y = { ...(t.dark ? dark : light).syntax, ...t.syntax }
  const bar = (x: number, yy: number, w: number, fill: string): string => `<rect x="${x}" y="${yy}" width="${w}" height="3" rx="1.5" fill="${fill}"/>`
  return `<svg viewBox="0 0 120 72" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="120" height="72" fill="${c.panel}"/>
    <rect y="0" width="120" height="9" fill="${c.panel}"/><rect x="94" y="2.5" width="20" height="4" rx="2" fill="${c.accent}"/>
    <rect y="9" width="120" height="0.6" fill="${c.border}"/>
    <rect x="0" y="9.6" width="26" height="62.4" fill="${c.panel}"/>
    ${bar(4, 15, 14, c.muted)}${bar(4, 21, 18, c.text)}${bar(4, 27, 12, c.text)}
    <rect x="26" y="9.6" width="56" height="62.4" fill="${c.bg}"/>
    ${bar(30, 15, 12, y.command)}${bar(43, 15, 20, c.text)}
    ${bar(30, 22, 34, c.text)}${bar(30, 29, 8, y.math)}${bar(40, 29, 22, c.text)}
    ${bar(30, 36, 10, y.command)}${bar(41, 36, 12, y.env)}
    ${bar(30, 43, 26, y.comment)}${bar(30, 50, 30, c.text)}
    <rect x="82" y="9.6" width="38" height="62.4" fill="${c.pdfBg}"/>
    <rect x="87" y="15" width="28" height="52" fill="#ffffff"/>
    ${bar(91, 20, 20, '#c8c8c8')}${bar(91, 26, 16, '#e0e0e0')}${bar(91, 31, 18, '#e0e0e0')}
  </svg>`
}
