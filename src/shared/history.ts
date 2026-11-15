// Version history: types shared by the main process and the page, and a small line diff (Myers).

/** Files OpenTex keeps versions of. */
export const HISTORY_EXT = /\.(tex|bib|sty|cls|txt|md)$/i

/**
 * Where a version came from: saved by you (save), saved automatically (auto), changed by someone or
 * something else (outside), the text just before a Design change or a restore, or how the file was
 * when OpenTex first saw it (open).
 */
export type VersionSource = 'save' | 'auto' | 'outside' | 'design' | 'restore' | 'open'

export interface Version {
  t: number // when (ms)
  src: VersionSource
  hash: string // sha1 of the text; the text is stored once per hash
  size: number // characters
  first?: number // automatic saves made in quick succession share one version; when the run started
  before?: 'design' | 'restore' // this text was also what OpenTex replaced in a Design change or a restore
}

export interface ChangedFile {
  path: string
  status: 'changed' | 'added' | 'deleted'
  base: Version | null // the version as it was at the chosen time
  added: number // lines
  removed: number
  outside: boolean // changed outside OpenTex at least once since then
}

export interface Session {
  start: number
  end: number
}

// ---------- Line diff ----------

/** A run of lines: equal in both (eq), only in the old text (del) or only in the new text (ins). */
export interface Run {
  kind: 'eq' | 'del' | 'ins'
  a: number // first line in the old text
  b: number // first line in the new text
  n: number
}

/**
 * Myers diff of two sequences of numbers. Common start and end are trimmed first, so small edits to
 * big files are quick. If the texts differ in more than `maxD` places the middle is reported as
 * removed and re-added, which keeps time and memory bounded.
 */
export function diffSeq(a: ArrayLike<number>, b: ArrayLike<number>, maxD = 2000): Run[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const out: Run[] = []
  const push = (r: Run): void => {
    if (r.n <= 0) return
    const last = out[out.length - 1]
    if (last && last.kind === r.kind && last.a + (r.kind === 'ins' ? 0 : last.n) === r.a && last.b + (r.kind === 'del' ? 0 : last.n) === r.b) last.n += r.n
    else out.push({ ...r })
  }
  push({ kind: 'eq', a: 0, b: 0, n: pre })
  for (const r of myers(a, pre, a.length - suf, b, pre, b.length - suf, maxD)) push(r)
  push({ kind: 'eq', a: a.length - suf, b: b.length - suf, n: suf })
  return out
}

function myers(a: ArrayLike<number>, a0: number, a1: number, b: ArrayLike<number>, b0: number, b1: number, maxD: number): Run[] {
  const N = a1 - a0
  const M = b1 - b0
  if (!N && !M) return []
  const whole = (): Run[] => [
    { kind: 'del', a: a0, b: b0, n: N },
    { kind: 'ins', a: a1, b: b0, n: M }
  ]
  if (!N || !M) return whole()
  const max = N + M
  const off = max + 1
  const V = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return whole()
    trace.push(V.slice(off - d, off + d + 1)) // the state after step d-1, for k in [-d, d]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
        x++
        y++
      }
      V[off + k] = x
      if (x >= N && y >= M) return backtrack(trace, d, N, M, a0, b0)
    }
  }
  return whole()
}

function backtrack(trace: Int32Array[], D: number, N: number, M: number, a0: number, b0: number): Run[] {
  const rev: Run[] = []
  let x = N
  let y = M
  for (let d = D; d > 0; d--) {
    const v = trace[d]
    const get = (k: number): number => v[k + d]
    const k = x - y
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = get(pk)
    const py = px - pk
    const sx = down ? px : px + 1
    if (x > sx) rev.push({ kind: 'eq', a: a0 + sx, b: b0 + sx - k, n: x - sx })
    if (down) rev.push({ kind: 'ins', a: a0 + px, b: b0 + py, n: 1 })
    else rev.push({ kind: 'del', a: a0 + px, b: b0 + py, n: 1 })
    x = px
    y = py
  }
  if (x > 0) rev.push({ kind: 'eq', a: a0, b: b0, n: x })
  // Merge single-line steps into runs.
  const out: Run[] = []
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i]
    const last = out[out.length - 1]
    if (last && last.kind === r.kind && (r.kind === 'ins' ? last.a === r.a && last.b + last.n === r.b : r.kind === 'del' ? last.b === r.b && last.a + last.n === r.a : last.a + last.n === r.a)) last.n += r.n
    else out.push({ ...r })
  }
  return out
}

/** Split text into lines (a final newline doesn't make an extra empty line). */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Line diff of two texts. */
export function diffLines(oldText: string, newText: string, maxD?: number): { a: string[]; b: string[]; runs: Run[] } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const runs = diffSeq(Int32Array.from(a, id), Int32Array.from(b, id), maxD)
  return { a, b, runs }
}

/** Lines added and removed. */
export function countChanges(runs: Run[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of runs) {
    if (r.kind === 'ins') added += r.n
    else if (r.kind === 'del') removed += r.n
  }
  return { added, removed }
}

/** Words and spaces of a line, for highlighting what changed inside it. */
export function diffWords(oldLine: string, newLine: string): { a: [string, boolean][]; b: [string, boolean][] } {
  const tok = (s: string): string[] => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []
  const ta = tok(oldLine)
  const tb = tok(newLine)
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const runs = diffSeq(Int32Array.from(ta, id), Int32Array.from(tb, id), 300)
  const a: [string, boolean][] = []
  const b: [string, boolean][] = []
  for (const r of runs) {
    if (r.kind !== 'ins') a.push([ta.slice(r.a, r.a + r.n).join(''), r.kind === 'del'])
    if (r.kind !== 'del') b.push([tb.slice(r.b, r.b + r.n).join(''), r.kind === 'ins'])
  }
  return { a, b }
}
