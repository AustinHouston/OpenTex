// Version history and crash recovery, kept in OpenTex's own folder (userData), never in the project,
// so shared folders (Dropbox, git, email) stay clean.
//
//   <userData>/history/<project id>/index.json      versions of each file, sessions
//   <userData>/history/<project id>/blobs/<sha1>.gz  each distinct text once, compressed
//   <userData>/recovery/<project id>/<file id>.json  unsaved text of open files, in case OpenTex closes

import { app, ipcMain, IpcMainInvokeEvent } from 'electron'
import { createHash } from 'crypto'
import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { gunzip, gzip } from 'zlib'
import type { TreeNode } from '../shared/types'
import { ChangedFile, countChanges, diffLines, HISTORY_EXT, Session, Version, VersionSource } from '../shared/history'
import type { Project } from './project'

const gz = promisify(gzip)
const gunz = promisify(gunzip)

const MAX_PER_FILE = 200
const MAX_BYTES = 200 * 1024 * 1024 // compressed, per project
const MAX_FILE = 5 * 1024 * 1024 // bigger files aren't versioned
const AUTO_RUN = 5 * 60 * 1000 // automatic saves within 5 minutes share one version
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const DISK_SOURCES = new Set<VersionSource>(['save', 'auto', 'outside', 'open']) // versions that were on disk

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')
const idOf = (root: string): string => sha1(root).slice(0, 20)
const historyRoot = (): string => join(app.getPath('userData'), 'history')
const recoveryDir = (root: string): string => join(app.getPath('userData'), 'recovery', idOf(root))

interface Index {
  version: 1
  root: string
  files: Record<string, Version[]> // oldest first
  blobs: Record<string, number> // hash → stored bytes
  sessions: Session[]
}

class Store {
  idx: Index = { version: 1, root: '', files: {}, blobs: {}, sessions: [] }
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(readonly root: string, readonly dir: string) {}

  static async load(root: string): Promise<Store> {
    const s = new Store(root, join(historyRoot(), idOf(root)))
    try {
      const raw = JSON.parse(await fs.readFile(join(s.dir, 'index.json'), 'utf8')) as Index
      if (raw && raw.files && raw.blobs) s.idx = { ...s.idx, ...raw, sessions: raw.sessions ?? [] }
    } catch {
      /* no history yet */
    }
    s.idx.root = root
    return s
  }

  /** Run one change at a time, in the order asked. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  touch(): void {
    const s = this.idx.sessions[this.idx.sessions.length - 1]
    if (s) s.end = Date.now()
    this.markDirty()
  }

  markDirty(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(() => this.write())
    }, 1000)
  }

  private async write(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, 'index.json.tmp')
    await fs.writeFile(tmp, JSON.stringify(this.idx))
    await fs.rename(tmp, join(this.dir, 'index.json'))
  }

  /** Write now (when OpenTex quits). */
  flushSync(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, 'index.json.tmp'), JSON.stringify(this.idx))
      renameSync(join(this.dir, 'index.json.tmp'), join(this.dir, 'index.json'))
    } catch (e) {
      console.warn('[opentex] could not save history index', e)
    }
  }

  latest(rel: string, onDisk = false): Version | undefined {
    const list = this.idx.files[rel] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (!onDisk || DISK_SOURCES.has(list[i].src)) return list[i]
    return undefined
  }

  /** Add a version unless it's the same as the latest one. Returns whether one was added. */
  async add(rel: string, text: string, src: VersionSource): Promise<boolean> {
    if (text.length > MAX_FILE) return false
    const hash = sha1(text)
    const list = (this.idx.files[rel] ??= [])
    const last = list[list.length - 1]
    if (last && last.hash === hash) {
      if (src === 'design' || src === 'restore') {
        last.before = src // the text being replaced is already kept: just label it
        this.markDirty()
      }
      return false
    }
    if (!(hash in this.idx.blobs)) {
      const data = await gz(Buffer.from(text, 'utf8'))
      await fs.mkdir(join(this.dir, 'blobs'), { recursive: true })
      await fs.writeFile(join(this.dir, 'blobs', `${hash}.gz`), data)
      this.idx.blobs[hash] = data.length
    }
    const now = Date.now()
    const v: Version = { t: now, src, hash, size: text.length }
    if (src === 'auto' && last && last.src === 'auto' && !last.before && now - (last.first ?? last.t) < AUTO_RUN) {
      // Typing with automatic saves: keep one version per few minutes, not one per pause.
      v.first = last.first ?? last.t
      list.pop()
    }
    list.push(v)
    this.prune(rel)
    await this.collect()
    this.touch()
    return true
  }

  /** Everything from the last day, one per hour for the last week, one per day before that. */
  private prune(rel: string): void {
    const list = this.idx.files[rel]
    if (!list || list.length < 2) return
    const now = Date.now()
    const tz = new Date().getTimezoneOffset() * 60000
    const seen = new Set<string>()
    const keep: Version[] = []
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i]
      const age = now - v.t
      if (i === list.length - 1 || age < DAY) keep.push(v)
      else {
        const bucket = age < 7 * DAY ? `h${Math.floor(v.t / HOUR)}` : `d${Math.floor((v.t - tz) / DAY)}`
        if (!seen.has(bucket)) {
          seen.add(bucket)
          keep.push(v)
        }
      }
    }
    keep.reverse()
    this.idx.files[rel] = keep.slice(Math.max(0, keep.length - MAX_PER_FILE))
  }

  /** Delete stored texts no version uses, and the oldest versions if the project uses too much space. */
  private async collect(): Promise<void> {
    let total = Object.values(this.idx.blobs).reduce((a, b) => a + b, 0)
    if (total > MAX_BYTES) {
      const all: [string, Version][] = []
      for (const [rel, list] of Object.entries(this.idx.files)) for (const v of list.slice(0, -1)) all.push([rel, v])
      all.sort((x, y) => x[1].t - y[1].t)
      const drop = new Set<Version>()
      for (const [, v] of all) {
        if (total <= MAX_BYTES * 0.9) break
        drop.add(v)
        total -= this.idx.blobs[v.hash] ?? 0 // roughly; shared texts are counted once below
      }
      for (const rel of Object.keys(this.idx.files)) this.idx.files[rel] = this.idx.files[rel].filter((v) => !drop.has(v))
    }
    const used = new Set<string>()
    for (const list of Object.values(this.idx.files)) for (const v of list) used.add(v.hash)
    for (const h of Object.keys(this.idx.blobs)) {
      if (used.has(h)) continue
      delete this.idx.blobs[h]
      await fs.unlink(join(this.dir, 'blobs', `${h}.gz`)).catch(() => {})
    }
  }

  async read(hash: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('Unknown version')
    return (await gunz(await fs.readFile(join(this.dir, 'blobs', `${hash}.gz`)))).toString('utf8')
  }
}

const stores = new Map<string, Promise<Store>>()
const loaded: Store[] = []
const storeFor = (root: string): Promise<Store> => {
  let s = stores.get(root)
  if (!s) {
    s = Store.load(root)
    stores.set(root, s)
    s.then((x) => loaded.push(x), () => stores.delete(root))
  }
  return s
}

// Texts OpenTex itself wrote, so a change on disk can be told apart from someone else's.
const ownWrites = new Map<string, string>()
/** Called from the file:write handler. */
export function noteWrite(root: string, rel: string, text: string): void {
  if (HISTORY_EXT.test(rel)) ownWrites.set(`${root}\0${rel}`, sha1(text))
}

async function readText(p: Project, rel: string): Promise<string | null> {
  try {
    const abs = p.abs(rel)
    const st = await fs.stat(abs)
    if (!st.isFile() || st.size > MAX_FILE) return null
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

async function textFiles(p: Project): Promise<string[]> {
  const out: string[] = []
  const walk = (ns: TreeNode[]): void => ns.forEach((n) => (n.dir ? walk(n.children ?? []) : HISTORY_EXT.test(n.name) && out.push(n.path)))
  walk(await p.tree())
  return out
}

/** A file changed on disk: keep it as a version, labelled by who changed it. */
async function noteDisk(store: Store, p: Project, rel: string, text: string, fresh: boolean): Promise<void> {
  const hash = sha1(text)
  const onDisk = store.latest(rel, true)
  if (onDisk?.hash === hash) return
  const own = ownWrites.get(`${p.root}\0${rel}`) === hash
  await store.add(rel, text, own ? 'save' : fresh ? 'open' : 'outside')
}

// Recovery files are written and removed one at a time per project, in the order asked.
const recoveryQueues = new Map<string, Promise<unknown>>()
function inOrder<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = recoveryQueues.get(root) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  recoveryQueues.set(root, next.catch(() => {}))
  return next
}

export function registerHistoryIpc(need: (e: IpcMainInvokeEvent) => Project): void {
  const handle = (op: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void => ipcMain.handle(`history:${op}`, fn) // eslint-disable-line @typescript-eslint/no-explicit-any
  const storeOf = (e: IpcMainInvokeEvent): Promise<{ p: Project; store: Store }> => {
    const p = need(e)
    return storeFor(p.root).then((store) => ({ p, store }))
  }

  /** A project was opened: start a session and note any file that changed while OpenTex wasn't watching. */
  handle('opened', async (e) => {
    const { p, store } = await storeOf(e)
    const sessions = store.idx.sessions.slice()
    const fresh = !sessions.length
    store.idx.sessions = [...sessions, { start: Date.now(), end: Date.now() }].slice(-60)
    store.markDirty()
    void store.run(async () => {
      for (const rel of await textFiles(p)) {
        const text = await readText(p, rel)
        if (text !== null) await noteDisk(store, p, rel, text, fresh)
      }
    })
    return sessions.reverse() // newest first
  })
  handle('touch', async (e) => (await storeOf(e)).store.touch())
  handle('snapshot', async (e, rel: string, text: string | null, src: VersionSource) => {
    if (!HISTORY_EXT.test(rel)) return false
    const { p, store } = await storeOf(e)
    return store.run(async () => {
      const t = text ?? (await readText(p, rel))
      return t === null ? false : store.add(rel, t, src)
    })
  })
  handle('checkDisk', async (e, rels: string[]) => {
    const { p, store } = await storeOf(e)
    await store.run(async () => {
      for (const rel of rels.filter((r) => HISTORY_EXT.test(r))) {
        const text = await readText(p, rel)
        if (text !== null) await noteDisk(store, p, rel, text, false)
      }
    })
  })
  handle('list', async (e, rel: string) => {
    const { store } = await storeOf(e)
    return (store.idx.files[rel] ?? []).slice().reverse()
  })
  handle('read', async (e, hash: string) => (await storeOf(e)).store.read(hash))
  /** Which files are different now from how they were at time `t`. `live` has the text of files with unsaved edits. */
  handle('changesSince', async (e, t: number, live: Record<string, string>) => {
    const { p, store } = await storeOf(e)
    await store.run(async () => {}) // let pending versions land first
    const paths = new Set([...Object.keys(store.idx.files), ...(await textFiles(p)), ...Object.keys(live)])
    const out: ChangedFile[] = []
    for (const rel of [...paths].sort()) {
      const list = store.idx.files[rel] ?? []
      let base: Version | null = null
      for (const v of list) if (v.t <= t && DISK_SOURCES.has(v.src)) base = v
      const now = rel in live ? live[rel] : await readText(p, rel)
      const outside = list.some((v) => v.t > t && v.src === 'outside')
      if (!base) {
        // New since then, unless OpenTex simply wasn't keeping history yet.
        const first = list[0]
        if (now !== null && first && first.t > t && first.src !== 'open') out.push({ path: rel, status: 'added', base: null, added: now.split('\n').length, removed: 0, outside })
        continue
      }
      if (now === null) {
        if (list.length) out.push({ path: rel, status: 'deleted', base, added: 0, removed: base.size ? (await store.read(base.hash)).split('\n').length : 0, outside })
        continue
      }
      if (sha1(now) === base.hash) continue
      const { added, removed } = countChanges(diffLines(await store.read(base.hash).catch(() => ''), now).runs)
      out.push({ path: rel, status: 'changed', base, added, removed, outside })
    }
    return out
  })

  // ---------- Crash recovery ----------
  // The page passes its project folder, so a write landing while another folder opens goes to the right place.
  const recFile = (root: string, rel: string): string => join(recoveryDir(root), `${sha1(rel).slice(0, 20)}.json`)
  handle('recoveryWrite', (_e, root: string, rel: string, text: string) =>
    inOrder(root, async () => {
      await fs.mkdir(recoveryDir(root), { recursive: true })
      const tmp = recFile(root, rel) + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({ root, path: rel, t: Date.now(), text }))
      await fs.rename(tmp, recFile(root, rel))
    })
  )
  handle('recoveryClear', (_e, root: string, rel: string | null) =>
    inOrder(root, async () => {
      if (rel === null) await fs.rm(recoveryDir(root), { recursive: true, force: true })
      else await fs.unlink(recFile(root, rel)).catch(() => {})
    })
  )
  /** Unsaved text left over from last time that differs from the file on disk. */
  handle('recoveryList', async (e) => {
    const p = need(e)
    return inOrder(p.root, async () => {
      const dir = recoveryDir(p.root)
      const out: { path: string; t: number; text: string; missing: boolean }[] = []
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!name.endsWith('.json')) continue
        const file = join(dir, name)
        try {
          const r = JSON.parse(await fs.readFile(file, 'utf8')) as { root: string; path: string; t: number; text: string }
          if (r.root !== p.root || typeof r.text !== 'string') continue
          p.abs(r.path) // refuses paths outside the project
          const disk = await fs.readFile(p.abs(r.path), 'utf8').catch(() => null)
          if (disk === r.text) await fs.unlink(file).catch(() => {})
          else out.push({ path: r.path, t: r.t, text: r.text, missing: disk === null })
        } catch {
          /* unreadable: ignore */
        }
      }
      return out.sort((a, b) => a.path.localeCompare(b.path))
    })
  })

  app.on('before-quit', () => loaded.forEach((s) => s.flushSync()))
}
