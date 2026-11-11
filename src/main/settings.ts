import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, Settings, Theme } from '../shared/types'

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
export const themesDir = (): string => join(app.getPath('userData'), 'themes')

let cache: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    cache = { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  cache = next
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2))
  return next
}

export function settingsPath(): string {
  return settingsFile()
}

/** User themes: any *.json file in <userData>/themes. */
export async function loadUserThemes(): Promise<Theme[]> {
  const dir = themesDir()
  await fs.mkdir(dir, { recursive: true })
  const out: Theme[] = []
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const t = JSON.parse(await fs.readFile(join(dir, f), 'utf8'))
      if (t && t.name && t.colors) out.push({ dark: false, syntax: {}, ...t })
    } catch (e) {
      console.warn(`Skipping invalid theme ${f}:`, e)
    }
  }
  return out
}
