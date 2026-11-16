import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, Settings, Theme } from '../shared/types'
import { migrateLiveSettings } from '../shared/live-preview'

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
export const themesDir = (): string => join(app.getPath('userData'), 'themes')

let cache: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  const text = await fs.readFile(settingsFile(), 'utf8').catch(() => null)
  try {
    // Notepad on Windows starts the file with a byte-order mark, which JSON.parse rejects.
    const raw = text === null ? {} : JSON.parse(text.replace(/^\uFEFF/, ''))
    cache = migrateLiveSettings({ ...DEFAULT_SETTINGS, ...raw })
  } catch {
    // Unreadable: start from the defaults, but keep a copy first, since the next save replaces it.
    await fs.copyFile(settingsFile(), join(app.getPath('userData'), `settings.unreadable-${Date.now()}.json`)).catch(() => {})
    console.warn('[opentex] settings.json could not be read; a copy was kept next to it')
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

let writing: Promise<void> = Promise.resolve()

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  cache = next
  // One write at a time, each to a temporary file that then replaces settings.json in one step,
  // so a crash or a second window saving at the same moment can never leave half a file.
  const write = async (): Promise<void> => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    const tmp = settingsFile() + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2))
    await fs.rename(tmp, settingsFile())
  }
  writing = writing.then(write, write)
  await writing
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
