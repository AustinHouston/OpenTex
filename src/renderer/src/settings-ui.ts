import type { PluginInfo, Settings, TexInfo, Theme } from '../../shared/types'
import { themePreview } from './themes'

type Api = { openThemesFolder: () => void; openSettingsFile: () => void; openPluginsFolder: () => void; detectTex: () => Promise<TexInfo> }

/** Settings dialog. Every change is applied live through `onChange`. */
export function openSettings(s: Settings, themes: Theme[], tex: TexInfo, api: Api, onChange: (patch: Partial<Settings>) => Promise<void>, plugins: PluginInfo[] = []): void {
  const d = document.getElementById('settings-dialog') as HTMLDialogElement
  const opt = (v: string, label: string, cur: string): string => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`
  d.innerHTML = `
    <div class="pane-head"><span>Settings</span><span class="spacer"></span><button class="link" data-close>Done</button></div>
    <div class="settings">
      <h3>Appearance</h3>
      <div class="theme-grid">${themes
        .map((t) => `<button class="theme-card${t.name === s.theme ? ' on' : ''}" data-theme="${t.name.replace(/"/g, '&quot;')}">${themePreview(t)}<span></span></button>`)
        .join('')}</div>
      <span></span><span class="note">Add your own: drop a theme .json into the themes folder. <button class="link" data-act="themes">Open themes folder</button></span>
      <label>Editor font</label><input type="text" name="fontFamily" />
      <label>Font size</label><input type="number" name="fontSize" min="8" max="40" />
      <label>Line height</label><input type="number" name="lineHeight" min="1" max="3" step="0.1" />
      <label>Check spelling</label><input type="checkbox" name="spellcheck" />
      <h3>Focus mode</h3>
      <label>Text width (characters)</label><input type="number" name="focusWidth" min="40" max="200" />
      <label>Dim other paragraphs</label><input type="checkbox" name="focusDim" />
      <label>Go full screen</label><input type="checkbox" name="focusFullscreen" />
      <h3>Compiling</h3>
      <label>Default engine</label><select name="engine">${opt('pdflatex', 'pdfLaTeX', s.engine)}${opt('xelatex', 'XeLaTeX', s.engine)}${opt('lualatex', 'LuaLaTeX', s.engine)}</select>
      <label>Compile on save</label><input type="checkbox" name="compileOnSave" />
      <label>Compile while typing</label><input type="checkbox" name="liveCompile" />
      <span></span><span class="note">Saves and compiles 1.5 seconds after you stop typing.</span>
      <label>Use latexmk</label><input type="checkbox" name="useLatexmk" />
      <label>TeX folder</label><input type="text" name="texPath" placeholder="Auto-detect" />
      <span></span><span class="note" data-tex>${tex.found ? `Found: ${tex.binDir}` : 'No TeX installation found. Use Build → Install TinyTeX… to get one.'}</span>
      <h3>Comments</h3>
      <label>Your name</label><input type="text" name="authorName" placeholder="Shown on comments you add" />
      <h3>Plugins</h3>
      ${plugins.map((p) => `<label class="plugin-name"></label><span class="plugin-row"><input type="checkbox" data-plugin="${p.id}" ${s.disabledPlugins.includes(p.id) ? '' : 'checked'} /><span class="note-inline"></span></span>`).join('')}
      <span></span><span class="note">Plugins add panels on the right. Put your own in the plugins folder (see the README). <button class="link" data-act="plugins">Open plugins folder</button></span>
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
  d.querySelectorAll<HTMLButtonElement>('.theme-card').forEach((b) => {
    b.querySelector('span')!.textContent = b.dataset.theme!
    b.onclick = async () => {
      d.querySelectorAll('.theme-card').forEach((x) => x.classList.toggle('on', x === b))
      await onChange({ theme: b.dataset.theme! })
    }
  })
  const names = d.querySelectorAll('.plugin-name')
  const notes = d.querySelectorAll('.plugin-row .note-inline')
  plugins.forEach((p, i) => {
    names[i].textContent = `${p.icon ? p.icon + ' ' : ''}${p.name}`
    notes[i].textContent = p.description
  })
  d.querySelectorAll<HTMLInputElement>('[data-plugin]').forEach((cb) => {
    cb.onchange = () => {
      const off = new Set(s.disabledPlugins)
      cb.checked ? off.delete(cb.dataset.plugin!) : off.add(cb.dataset.plugin!)
      s = { ...s, disabledPlugins: [...off] }
      onChange({ disabledPlugins: [...off] })
    }
  })
  d.querySelector('[data-act=plugins]')!.addEventListener('click', () => api.openPluginsFolder())
  d.querySelector('[data-act=themes]')!.addEventListener('click', () => api.openThemesFolder())
  d.querySelector('[data-act=file]')!.addEventListener('click', () => api.openSettingsFile())
  d.querySelector('[data-close]')!.addEventListener('click', () => d.close())
  d.showModal()
}
