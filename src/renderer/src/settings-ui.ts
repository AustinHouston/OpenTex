import type { Settings, TexInfo, Theme } from '../../shared/types'

type Api = { openThemesFolder: () => void; openSettingsFile: () => void; detectTex: () => Promise<TexInfo> }

/** Settings dialog. Every change is applied live through `onChange`. */
export function openSettings(s: Settings, themes: Theme[], tex: TexInfo, api: Api, onChange: (patch: Partial<Settings>) => Promise<void>): void {
  const d = document.getElementById('settings-dialog') as HTMLDialogElement
  const opt = (v: string, label: string, cur: string): string => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`
  d.innerHTML = `
    <div class="pane-head"><span>Settings</span><span class="spacer"></span><button class="link" data-close>Done</button></div>
    <div class="settings">
      <h3>Appearance</h3>
      <label>Theme</label><select name="theme">${themes.map((t) => opt(t.name, t.name, s.theme)).join('')}</select>
      <span></span><span class="note">Add your own: drop a theme .json into the themes folder. <button class="link" data-act="themes">Open themes folder</button></span>
      <label>Editor font</label><input type="text" name="fontFamily" />
      <label>Font size</label><input type="number" name="fontSize" min="8" max="40" />
      <label>Line height</label><input type="number" name="lineHeight" min="1" max="3" step="0.1" />
      <h3>Focus mode</h3>
      <label>Text width (characters)</label><input type="number" name="focusWidth" min="40" max="200" />
      <label>Dim other paragraphs</label><input type="checkbox" name="focusDim" />
      <label>Go full screen</label><input type="checkbox" name="focusFullscreen" />
      <h3>Compiling</h3>
      <label>Default engine</label><select name="engine">${opt('pdflatex', 'pdfLaTeX', s.engine)}${opt('xelatex', 'XeLaTeX', s.engine)}${opt('lualatex', 'LuaLaTeX', s.engine)}</select>
      <label>Compile on save</label><input type="checkbox" name="compileOnSave" />
      <label>Use latexmk</label><input type="checkbox" name="useLatexmk" />
      <label>TeX folder</label><input type="text" name="texPath" placeholder="Auto-detect" />
      <span></span><span class="note" data-tex>${tex.found ? `Found: ${tex.binDir}` : 'No TeX installation found. Use Build → Install TinyTeX… to get one.'}</span>
      <h3>Comments</h3>
      <label>Your name</label><input type="text" name="authorName" placeholder="Shown on comments you add" />
      <h3>Advanced</h3>
      <span></span><span><button class="link" data-act="file">Open settings.json</button></span>
    </div>`
  d.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]').forEach((el) => {
    const key = el.name as keyof Settings
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(s[key])
    else el.value = String(s[key])
    el.addEventListener('change', async () => {
      let v: string | number | boolean = el.value
      if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked
      else if (el instanceof HTMLInputElement && el.type === 'number') v = Number(el.value)
      await onChange({ [key]: v } as Partial<Settings>)
      if (key === 'texPath') {
        const t = await api.detectTex()
        d.querySelector('[data-tex]')!.textContent = t.found ? `Found: ${t.binDir}` : 'No TeX found in that folder.'
      }
    })
  })
  d.querySelector('[data-act=themes]')!.addEventListener('click', () => api.openThemesFolder())
  d.querySelector('[data-act=file]')!.addEventListener('click', () => api.openSettingsFile())
  d.querySelector('[data-close]')!.addEventListener('click', () => d.close())
  d.showModal()
}
