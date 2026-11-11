# OpenTex

A simple, reliable LaTeX editor for writing papers. OpenTex opens one project folder at a time, compiles with **your own TeX installation**, and shows the PDF beside your text. Share the folder with collaborators however you like (email, Dropbox, git): OpenTex notices when files change on disk and reloads them.

## Features

- Project folder with file tree; main `.tex` file is detected automatically (`% !TEX root = …`, or the file with `\documentclass`)
- LaTeX syntax highlighting, search, bracket matching, tabs
- Compile with latexmk (or pdfLaTeX/XeLaTeX/LuaLaTeX + BibTeX/Biber directly), compile-on-save, clickable error list
- Built-in PDF viewer that keeps your place between compiles
- Themes (Light, Dark, Sepia, Solarized Dark) plus your own
- **Focus mode** (`Ctrl/Cmd+Shift+F`, `Esc` to leave): hides everything except the text, centers it, and dims all but the current paragraph
- **Comments** that live in the `.tex` file, so they travel with the paper (see below)
- **One-click TinyTeX install** if you don't have TeX, and missing packages are installed when a paper needs them

## Installing

Download the latest installer from the Releases page: `OpenTex-…-mac-universal.dmg` for macOS or `OpenTex-Setup-….exe` for Windows.

Until the app is code-signed, your computer will warn you the first time:

- **macOS:** open the `.dmg` and drag OpenTex to Applications. The first time you open it, macOS says it can't verify the developer. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

## Comments

Comments are ordinary LaTeX comment lines, so they never appear in the PDF and they survive email, Dropbox, git and other editors:

```latex
%@comment[Jane Doe, 2026-11-10]: Should we cite Jackson for this?
%@reply[Austin Houston, 2026-11-11]: Yes, adding it.
%@resolved
We solve the Poisson equation...
```

A thread belongs to the line right below it. In OpenTex, put the cursor on a line and click the speech-bubble button (or `Ctrl/Cmd+Shift+M`). The **Comments** tab in the sidebar lists every thread in the project, with Reply, Resolve and Delete. Set your name once in Settings.

## Keyboard shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Open folder | ⌘O | Ctrl+O |
| Save | ⌘S | Ctrl+S |
| Compile | ⌘↩ | Ctrl+Enter |
| Focus mode | ⇧⌘F | Ctrl+Shift+F |
| Toggle sidebar / PDF | ⌘B / ⇧⌘P | Ctrl+B / Ctrl+Shift+P |
| Add comment | ⇧⌘M | Ctrl+Shift+M |
| Settings | ⌘, | Ctrl+, |

## You need TeX installed

OpenTex uses the TeX on your computer. If none is found, OpenTex offers to install **TinyTeX** for you (~100 MB, a standard TeX Live, installed in your user folder with no administrator password). You can also do it any time from **Build → Install TinyTeX…**. With TinyTeX, when a paper needs a package you don't have, OpenTex offers to install it.

You can also use a full distribution: **MacTeX** (<https://tug.org/mactex/>) on macOS or **MiKTeX** (<https://miktex.org/>) on Windows.

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

### Making a release

Bump `version` in `package.json`, then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) builds the macOS `.dmg` and the Windows installer and attaches them to a draft release. Publish the draft when you're happy. To sign the apps (which removes the security warnings), add the secrets listed at the top of that workflow file.

Code layout:

- `src/main/`: Electron main process (project folder, TeX detection and compiling, TinyTeX installer, settings)
- `src/preload/`: the small API the page is allowed to use
- `src/renderer/`: the UI (CodeMirror 6 editor, pdf.js viewer, themes, focus mode, comments)

## License

MIT
