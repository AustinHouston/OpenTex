// Look up a reference's BibTeX by DOI (doi.org, falling back to Crossref) or arXiv ID (arxiv.org).
// The page cleans the result and adds it to the project's .bib file (see renderer/src/doi.ts).
import { ipcMain, net } from 'electron'

export type DoiResult = { ok: true; bibtex: string; source: string } | { ok: false; reason: 'not-found' | 'network' | 'no-bibtex' | 'bad-reply'; detail?: string }

const UA = 'OpenTex (https://github.com/AustinHouston/OpenTex)'
const TIMEOUT_MS = 10_000

type Got = { status: number; text: string } | { error: string }

async function get(url: string, accept: string): Promise<Got> {
  try {
    const r = await net.fetch(url, {
      headers: { Accept: accept, 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = r.status === 200 ? await r.text() : ''
    return { status: r.status, text }
  } catch (e) {
    return { error: (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message }
  }
}

const isBibtex = (s: string): boolean => /^\s*@\w+\s*\{/.test(s)

/** `id` is a bare DOI (10.xxxx/…) or a bare arXiv ID (2101.00001, hep-th/9901001). */
export async function lookUp(id: string, kind: 'doi' | 'arxiv'): Promise<DoiResult> {
  if (kind === 'arxiv') {
    const r = await get(`https://arxiv.org/bibtex/${encodeURIComponent(id).replace(/%2F/gi, '/')}`, 'text/plain')
    if ('error' in r) return { ok: false, reason: 'network', detail: r.error }
    if (r.status === 404 || (r.status === 200 && !isBibtex(r.text))) return { ok: false, reason: 'not-found' }
    if (r.status !== 200) return { ok: false, reason: 'bad-reply', detail: `arxiv.org answered ${r.status}` }
    return { ok: true, bibtex: r.text, source: 'arxiv.org' }
  }
  // DOIs may contain characters like < > # ; keep the slashes readable.
  const path = id.split('/').map(encodeURIComponent).join('/')
  const first = await get(`https://doi.org/${path}`, 'application/x-bibtex')
  if (!('error' in first)) {
    if (first.status === 200 && isBibtex(first.text)) return { ok: true, bibtex: first.text, source: 'doi.org' }
    if (first.status === 404) return { ok: false, reason: 'not-found' }
  }
  // doi.org unreachable, or the DOI's registrar didn't send BibTeX: ask Crossref directly.
  const second = await get(`https://api.crossref.org/works/${path}/transform/application/x-bibtex`, 'application/x-bibtex')
  if (!('error' in second) && second.status === 200 && isBibtex(second.text)) return { ok: true, bibtex: second.text, source: 'Crossref' }
  if ('error' in first) return { ok: false, reason: 'network', detail: first.error }
  // doi.org knows the DOI (it answered, just not with BibTeX), but Crossref doesn't have it.
  if (first.status === 200) return { ok: false, reason: 'no-bibtex' }
  return { ok: false, reason: 'bad-reply', detail: `doi.org answered ${first.status}` }
}

export function registerDoiIpc(): void {
  ipcMain.handle('doi:lookup', (_e, id: string, kind: 'doi' | 'arxiv') => lookUp(String(id).slice(0, 300), kind === 'arxiv' ? 'arxiv' : 'doi'))
}
