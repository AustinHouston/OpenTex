// Plugins are folders containing a plugin.json and a web page that OpenTex shows as a panel.
// Built-in plugins ship in <app>/plugins; your own go in <userData>/plugins.
// Each panel runs in a sandboxed frame with no access to your files; it talks to OpenTex
// only through the small message API in opentex-sdk.js (theme, storage, notifications).
import { app, protocol } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { extname, join, resolve, sep } from 'path'

import type { PluginInfo } from '../shared/types'

const dirs = new Map<string, string>()

export const builtinPluginsDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'plugins'))
export const userPluginsDir = (): string => join(app.getPath('userData'), 'plugins')

export async function listPlugins(): Promise<PluginInfo[]> {
  await fs.mkdir(userPluginsDir(), { recursive: true })
  const out: PluginInfo[] = []
  dirs.clear()
  for (const [base, builtIn] of [[builtinPluginsDir(), true], [userPluginsDir(), false]] as const) {
    for (const name of await fs.readdir(base).catch(() => [] as string[])) {
      const dir = join(base, name)
      try {
        const meta = JSON.parse(await fs.readFile(join(dir, 'plugin.json'), 'utf8'))
        const id = String(meta.id || name).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        if (dirs.has(id)) continue
        dirs.set(id, dir)
        out.push({ id, name: meta.name || name, description: meta.description || '', version: meta.version || '', panel: meta.panel || 'index.html', icon: meta.icon || '', permissions: Array.isArray(meta.permissions) ? meta.permissions.map(String) : [], builtIn })
      } catch {
        /* not a plugin folder */
      }
    }
  }
  return out
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2'
}

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'opentex-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Serves opentex-plugin://<id>/<file> from that plugin's folder only. */
export function servePlugins(sdkPath: string): void {
  protocol.handle('opentex-plugin', async (req) => {
    const url = new URL(req.url)
    const dir = dirs.get(url.hostname)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = rel === 'opentex-sdk.js' ? sdkPath : dir ? resolve(dir, rel) : ''
    if (!file || (rel !== 'opentex-sdk.js' && !file.startsWith(resolve(dir!) + sep)) || !existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(await fs.readFile(file), { headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' } })
  })
}

const dataFile = (id: string): string => join(app.getPath('userData'), 'plugin-data', `${id.replace(/[^a-z0-9-]/gi, '')}.json`)

export async function pluginStorageGet(id: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(dataFile(id), 'utf8'))
  } catch {
    return {}
  }
}

export async function pluginStorageSet(id: string, key: string, value: unknown): Promise<void> {
  const data = await pluginStorageGet(id)
  data[key] = value
  await fs.mkdir(join(app.getPath('userData'), 'plugin-data'), { recursive: true })
  await fs.writeFile(dataFile(id), JSON.stringify(data, null, 2))
}
