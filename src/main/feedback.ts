// "Report a Bug" and "Suggest a Feature": open a new GitHub issue in the user's browser with the
// OpenTex version and system already filled in. Nothing is sent by OpenTex itself, and nothing
// personal goes into the link: no names, file paths or project contents.
import { app, ipcMain, shell } from 'electron'
import { arch, release } from 'os'
import { detectTex } from './tex'
import { loadSettings } from './settings'

const REPO = 'https://github.com/AustinHouston/OpenTex'

function osName(): string {
  if (process.platform === 'darwin') return `macOS (Darwin ${release()})`
  if (process.platform === 'win32') return `Windows ${release()}`
  return `${process.platform} ${release()}`
}

/** Which TeX the user has, by name only (the folder path would include their user name). */
function texName(binDir: string | null): string {
  if (!binDir) return 'none found'
  if (/tinytex/i.test(binDir)) return 'TinyTeX'
  if (/miktex/i.test(binDir)) return 'MiKTeX'
  const year = /texlive[\\/](\d{4})/i.exec(binDir)?.[1]
  if (year) return `TeX Live ${year}${/basic/i.test(binDir) ? ' (BasicTeX)' : ''}`
  if (/texbin/i.test(binDir)) return 'MacTeX / TeX Live'
  return 'found'
}

export async function issueUrl(kind: 'bug' | 'idea'): Promise<string> {
  const s = await loadSettings()
  const system = [
    `- OpenTex ${app.getVersion()}`,
    `- ${osName()}, ${arch()}`,
    `- TeX: ${texName(detectTex(s.texPath).binDir)}, engine ${s.engine}${s.useLatexmk ? ' with latexmk' : ''}`
  ].join('\n')
  const body =
    kind === 'bug'
      ? `**What happened?**\n\n\n**What did you expect to happen?**\n\n\n**Steps to make it happen again**\n1. \n2. \n\n**Screenshot or the error message** (optional; please leave out anything private)\n\n\n---\n${system}\n`
      : `**What would you like OpenTex to do?**\n\n\n**Why would it help you?**\n\n\n---\n${system}\n`
  const q = new URLSearchParams({ title: kind === 'bug' ? 'Bug: ' : 'Idea: ', body, labels: kind === 'bug' ? 'bug' : 'enhancement' })
  return `${REPO}/issues/new?${q.toString()}`
}

export function registerFeedbackIpc(): void {
  ipcMain.handle('feedback:open', async (_e, kind: 'bug' | 'idea') => shell.openExternal(await issueUrl(kind === 'idea' ? 'idea' : 'bug')))
}
