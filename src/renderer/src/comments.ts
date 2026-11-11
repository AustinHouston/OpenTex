// The older comment format: %@comment lines inside the .tex source. OpenTex now keeps comments in
// comments.opentex.json (see review.ts); this parser is used to convert old projects and Word imports:
//
//   %@comment[Austin Houston, 2026-11-11]{the quoted text}: Is this the right reference?
//   %@reply[Jane Doe, 2026-11-12]: Fixed, thanks.
//   %@resolved
//   The line being commented on comes right after the thread. The {quoted text} part is
//   optional; when present, that text is highlighted in the lines below the thread.


export interface CommentEntry {
  author: string
  date: string
  text: string
  line: number
}
export interface CommentThread extends CommentEntry {
  file: string
  endLine: number // last line of the thread (replies / resolved marker)
  targetLine: number // the line the thread is about: the first non-comment line below it
  replies: CommentEntry[]
  resolved: boolean
  indent: string
  context: string // the line the thread is attached to
  quote: string // selected text the comment is about ('' if none)
}

const ENTRY = /^(\s*)%@(comment|reply)\[([^\],]*)(?:,\s*([^\]]*))?\](?:\{([^}]*)\})?:\s?(.*)$/
const RESOLVED = /^\s*%@resolved\b/

export function parseComments(text: string, file: string): CommentThread[] {
  const lines = text.split('\n')
  const out: CommentThread[] = []
  let cur: CommentThread | null = null
  let stacked: CommentThread[] = [] // consecutive threads all belong to the next ordinary line
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = l.match(ENTRY)
    if (m && m[2] === 'comment') {
      cur = { file, line: i + 1, endLine: i + 1, targetLine: i + 2, indent: m[1], author: m[3].trim(), date: (m[4] ?? '').trim(), quote: (m[5] ?? '').trim(), text: m[6], replies: [], resolved: false, context: '' }
      out.push(cur)
      stacked.push(cur)
    } else if (cur && m && m[2] === 'reply') {
      cur.replies.push({ author: m[3].trim(), date: (m[4] ?? '').trim(), text: m[6], line: i + 1 })
      cur.endLine = i + 1
    } else if (cur && RESOLVED.test(l)) {
      cur.resolved = true
      cur.endLine = i + 1
    } else {
      for (const t of stacked) {
        t.context = l.trim()
        t.targetLine = i + 1
      }
      stacked = []
      cur = null
    }
  }
  return out
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const cleanName = (s: string): string => s.replace(/[\],\n]/g, ' ').trim()
export const cleanText = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

/** Selected text stored with a comment: one line, no braces, at most 160 characters. */
export const cleanQuote = (s: string): string => s.replace(/[{}%]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)

export function entryLine(kind: 'comment' | 'reply', author: string, text: string, indent = '', quote = ''): string {
  const q = quote ? `{${cleanQuote(quote)}}` : ''
  return `${indent}%@${kind}[${cleanName(author)}, ${today()}]${q}: ${cleanText(text)}`
}

/** Find a quote in the text after a thread, letting any run of whitespace (including line breaks) match. */
export function findQuote(text: string, quote: string): [number, number] | null {
  const words = quote.split(' ').filter(Boolean)
  if (!words.length) return null
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'))
  const m = re.exec(text)
  return m ? [m.index, m.index + m[0].length] : null
}
