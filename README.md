# OpenTex

A simple, reliable LaTeX editor for writing papers. OpenTex opens one project folder at a time, compiles with **your own TeX installation**, and shows the PDF beside your text. Share the folder with collaborators however you like (email, Dropbox, git): OpenTex notices when files change on disk and reloads them.

## Features

- Project folder with file tree (folder and file-type icons, plus tags for main, tex, pdf, refs and images); main `.tex` file is detected automatically (`% !TEX root = …`, or the file with `\documentclass`)
- LaTeX syntax highlighting, search, bracket matching, tabs
- Autocomplete for `\cite{…}` (from your `.bib` files), `\ref{…}` (from your `\label`s), environments and commands
- Spellcheck that ignores LaTeX commands and math (right-click for suggestions), live word count
- **SyncTeX:** double-click the PDF to jump to that line of source; `Ctrl/Cmd+J` shows the current line in the PDF
- Optional compile-while-typing, git branch and change count in the status bar
- Compile with latexmk (or pdfLaTeX/XeLaTeX/LuaLaTeX + BibTeX/Biber directly), compile-on-save, clickable error list
- Built-in PDF viewer that keeps your place between compiles
- 12 built-in themes with previews in Settings, plus your own
- Interface zoom with `Ctrl/Cmd +` and `Ctrl/Cmd −`
- **Movable panels:** Files, PDF, Comments and plugin panels can be dragged by their title bar to the left, either right-hand column, or across the bottom, stacked, resized, collapsed (click the arrow or double-click the title) or hidden. The PDF is optional. The layout toolbar button shows hidden panels and resets the layout.
- **Plugins** that add panels on the right, such as the built-in **Forest Timer** (a Pomodoro timer with a pixel forest that grows while you work)
- **Focus mode** (`Ctrl/Cmd+Shift+F`, `Esc` to leave): hides everything except the text, centers it, and dims all but the current paragraph
- **Comments** that live in the `.tex` file, so they travel with the paper (see below)
- **One-click TinyTeX install** if you don't have TeX, and missing packages are installed when a paper needs them

## Download

| Your computer | Download |
| --- | --- |
| **Mac** (Apple Silicon or Intel) | **[OpenTex-mac.dmg](https://github.com/AustinHouston/OpenTex/releases/latest/download/OpenTex-mac.dmg)** |
| **Windows** | **[OpenTex-windows-setup.exe](https://github.com/AustinHouston/OpenTex/releases/latest/download/OpenTex-windows-setup.exe)** (installs just for you, no admin needed) |
| **Windows**, if installers are blocked | **[OpenTex-windows-portable.zip](https://github.com/AustinHouston/OpenTex/releases/latest/download/OpenTex-windows-portable.zip)** (nothing to install: unzip and run) |

There's also a download page at <https://austinhouston.github.io/OpenTex/>. All versions are on the [Releases page](https://github.com/AustinHouston/OpenTex/releases).

## Installing

No administrator rights are needed on either system.

### Mac

1. Open **OpenTex-mac.dmg** and drag **OpenTex** to **Applications**. If you aren't allowed to change Applications, drag it to your **Desktop** or **Documents** folder instead. It runs from anywhere.
2. Open OpenTex. The first time, macOS says it can't verify the developer. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to the message about OpenTex, and click **Open Anyway**. You only do this once.
   (On macOS 14 or earlier, you can instead right-click the app, choose **Open**, then **Open** again.)

### Windows

- **Installer:** double-click **OpenTex-windows-setup.exe**. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. OpenTex installs into your own user folder and adds a Start menu and desktop shortcut.
- **Portable (if the installer is blocked):** right-click **OpenTex-windows-portable.zip → Properties**, tick **Unblock**, and click **OK**. Then right-click it, choose **Extract All**, and double-click **OpenTex.exe** in the extracted folder. Keep that folder somewhere like Documents.

### On work or government computers

Some managed computers hide the *Open Anyway* / *Run anyway* buttons because policy only allows signed apps. If you don't see them, ask your IT help desk to approve OpenTex. It's open source, so they can review the code or build it themselves. Signed releases (see [Code signing](#code-signing)) remove this step entirely.

## Comments

Comments are ordinary LaTeX comment lines, so they never appear in the PDF and they survive email, Dropbox, git and other editors:

```latex
%@comment[Jane Doe, 2026-11-10]{Poisson equation}: Should we cite Jackson for this?
%@reply[Austin Houston, 2026-11-11]: Yes, adding it.
%@resolved
We solve the Poisson equation...
```

A thread belongs to the line right below it, and the optional `{…}` part is the text it's about (highlighted in the editor). To comment, **select text in the editor or in the PDF** and click the **+ Comment** bubble, or right-click it. Commenting on PDF text uses SyncTeX to find the matching source line. The **Comments** panel on the right lists every thread in the project, with Reply, Resolve and Delete. Set your name once in Settings.

## Plugins

Plugins add panels to the right-hand dock. Turn them on or off in **Settings → Plugins**. To write one, make a folder in the plugins folder (Settings → *Open plugins folder*) with:

- `plugin.json`: `{ "id": "my-plugin", "name": "My Plugin", "description": "…", "icon": "🔖", "panel": "index.html" }`
- `index.html`: an ordinary web page. Add `<script src="opentex-sdk.js"></script>` to get:
  - `OpenTex.onTheme(fn)`: the current theme (its colors are also set as CSS variables such as `--bg`, `--text`, `--accent`)
  - `OpenTex.onContext(fn)`: the open project, file and word count
  - `OpenTex.storage.get(key)` / `OpenTex.storage.set(key, value)`: saved between sessions
  - `OpenTex.notify(title, body)`: a system notification

Plugin pages run in a sandboxed frame. They can't read your files or reach the rest of OpenTex, only this API. See [`plugins/forest-timer`](plugins/forest-timer) for a complete example.

## Keyboard shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Open folder | ⌘O | Ctrl+O |
| Save | ⌘S | Ctrl+S |
| Compile | ⌘↩ | Ctrl+Enter |
| Focus mode | ⇧⌘F | Ctrl+Shift+F |
| Toggle sidebar / PDF | ⌘B / ⇧⌘P | Ctrl+B / Ctrl+Shift+P |
| Add comment | ⇧⌘M | Ctrl+Shift+M |
| Show line in PDF | ⌘J | Ctrl+J |
| Bigger / smaller / actual size | ⌘+ / ⌘− / ⌘0 (Ctrl works too) | Ctrl++ / Ctrl+− / Ctrl+0 |
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

GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) builds the Mac and Windows downloads and publishes them as a release. The file names stay the same every time, so the download links above always get the newest version.

### Code signing

Unsigned apps trigger the one-time security prompts described in [Installing](#installing), and some managed computers block them outright. Signing removes that:

- **Mac:** an Apple Developer ID (Apple Developer Program, $99/year). With it, the release is signed and notarized, and it opens with no warning.
- **Windows:** a code-signing certificate. Open-source projects can get one free from the [SignPath Foundation](https://signpath.org/); Azure Trusted Signing is a low-cost alternative.
- Your institution may already have certificates its IT department can sign with.

Add the certificates as repository secrets (names are listed at the top of the release workflow) and every release after that is signed automatically.

Code layout:

- `src/main/`: Electron main process (project folder, TeX detection and compiling, TinyTeX installer, settings)
- `src/preload/`: the small API the page is allowed to use
- `src/renderer/`: the UI (CodeMirror 6 editor, pdf.js viewer, themes, focus mode, comments, plugin dock)
- `plugins/`: built-in plugins and the plugin SDK
- `scripts/make-icon.cjs`: draws the app icon (`npx electron scripts/make-icon.cjs`)

## License

MIT
