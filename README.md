# OpenTex

A simple, reliable LaTeX editor for writing papers. OpenTex opens one project folder at a time, compiles with **your own TeX installation**, and shows the PDF beside your text. Share the folder with collaborators however you like (email, Dropbox, git): OpenTex notices when files change on disk and reloads them.

## Features

- Project folder with file tree; main `.tex` file is detected automatically (`% !TEX root = …`, or the file with `\documentclass`)
- LaTeX syntax highlighting, search, bracket matching, tabs
- Compile with latexmk (or pdfLaTeX/XeLaTeX/LuaLaTeX + BibTeX/Biber directly), compile-on-save, clickable error list
- Built-in PDF viewer that keeps your place between compiles
- Themes (Light, Dark, Sepia, Solarized Dark) plus your own
- **Focus mode** (`Ctrl/Cmd+Shift+F`, `Esc` to leave): hides everything except the text, centers it, and dims all but the current paragraph

## Keyboard shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Open folder | ⌘O | Ctrl+O |
| Save | ⌘S | Ctrl+S |
| Compile | ⌘↩ | Ctrl+Enter |
| Focus mode | ⇧⌘F | Ctrl+Shift+F |
| Toggle sidebar / PDF | ⌘B / ⇧⌘P | Ctrl+B / Ctrl+Shift+P |
| Settings | ⌘, | Ctrl+, |

## You need TeX installed

OpenTex uses the TeX on your computer. If you don't have one, install either:

- **TinyTeX** (small, ~100 MB): <https://yihui.org/tinytex/>
- **MacTeX** (macOS, full): <https://tug.org/mactex/> or **MiKTeX** (Windows): <https://miktex.org/>

OpenTex looks in the usual install locations. If it can't find yours, set the folder in **Settings → TeX folder**.

## Customizing

- **Themes:** Settings → *Open themes folder*, then drop in a `.json` file shaped like [`src/renderer/src/themes/dark.json`](src/renderer/src/themes/dark.json). Any key you leave out falls back to the default.
- **Settings file:** Settings → *Open settings.json*.
- **Per-project options** (main file, engine) live in `<project>/.opentex/project.json`, so collaborators get the same setup.

## Development

```bash
npm install
npm run dev        # run with hot reload
npm run typecheck
npm run dist:mac   # build a .dmg (dist/)
npm run dist:win   # build a Windows installer (dist/)
```

Code layout:

- `src/main/`: Electron main process (project folder, TeX detection and compiling, settings)
- `src/preload/`: the small API the page is allowed to use
- `src/renderer/`: the UI (CodeMirror 6 editor, pdf.js viewer, themes, focus mode)

## License

MIT
