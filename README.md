# OpenTex

A simple, reliable LaTeX editor for writing papers. OpenTex opens one project folder at a time, compiles with **your own TeX installation**, and shows the PDF beside your text. Share the folder with collaborators however you like (email, Dropbox, git): OpenTex notices when files change on disk and reloads them.

## Features

- A welcome page with your recent folders, **New Project** (a blank paper or the example), Open Folder and Import Word
- **Multiple windows**, each working in its own folder (File → New Window, Open Folder in New Window, Open Recent)
- An **example paper** (File → Open the Example Paper) laid out like a real paper (abstract, introduction, methods, results, conclusions) that teaches LaTeX as you read it: one sentence per line, paragraphs, citations, figures, tables, equations and cross-references
- Project folder with file tree (folder and file-type icons, plus tags for main, tex, pdf, refs and images); main `.tex` file is detected automatically (`% !TEX root = …`, or the file with `\documentclass`)
- LaTeX syntax highlighting, search, bracket matching, tabs
- Autocomplete for `\cite{…}` (from your `.bib` files), `\ref{…}` (from your `\label`s), environments and commands
- Spellcheck that ignores LaTeX commands and math (right-click for suggestions), live word count
- **SyncTeX:** double-click the PDF to jump to that line of source; `Ctrl/Cmd+J` shows the current line in the PDF
- Optional compile-while-typing, git branch and change count in the status bar
- Compile with latexmk (or pdfLaTeX/XeLaTeX/LuaLaTeX + BibTeX/Biber directly), compile-on-save, clickable error list
- Built-in PDF viewer that keeps your place between compiles
- 12 built-in themes with previews in Settings, plus your own
- **Insert panel** (`Ctrl/Cmd+Shift+I`, or the Insert menu): pick a table size from a grid, add numbered or inline equations and templates (fractions, roots, sums, integrals, derivatives, matrices, cases), insert a figure from your project's images, or click any of 150+ symbols: every Greek letter in both cases, operators, relations, arrows, sets, physics symbols and accents, with search. Symbols are wrapped in `$…$` automatically when you're not already in math, and OpenTex offers to add packages such as `amssymb` when a symbol needs one.
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

## Bringing in your existing work

### Word documents

Choose **File → Import Word Document…**, or drag a `.docx` file onto the OpenTex window. OpenTex makes a new project folder next to it (you can pick another place) containing:

- `main.tex`, with headings, formatting, lists, tables and footnotes, and Word equations converted to LaTeX math
- `media/`, holding the document's pictures
- `refs.bib`, if the document has citations from Zotero, Mendeley or EndNote that Pandoc can read

Tracked changes are accepted, and Word comments become [OpenTex comments](#comments). Your Word file isn't changed.

The conversion uses [Pandoc](https://pandoc.org), a free document converter. The first time, OpenTex offers to download it (about 35 MB) into its own folder, with no administrator rights needed. If your network blocks that, install Pandoc from pandoc.org (on Windows, the `.msi` installs just for you), and OpenTex will find it.

Older `.doc` files must be saved as `.docx` in Word first. Pictures stored in Windows-only formats (EMF/WMF) must be re-saved as PNG; OpenTex lists any it finds.

### EndNote, Zotero and Mendeley libraries

Choose **File → Import References…**, or drag the exported file onto the window. OpenTex adds the references to your project's `.bib` file with readable keys (like `novoselov2004electric`), and skips ones already there. If your main file has no bibliography yet, it offers to add one.

- **EndNote:** select all references, choose **File → Export…**, and pick **XML** as the type.
- **Zotero / Mendeley:** export the library or collection as **BibTeX** or **RIS**. Zotero's CSL JSON works too.
- Downloads from Web of Science, Scopus or PubMed in RIS format also work.

## Comments

Comments work like comments in Word. Select a word, a sentence or several paragraphs, in the editor or in the PDF, and click the **+ Comment** bubble (or right-click). To comment on a single spot, put the cursor there and press `Ctrl/Cmd+Shift+M`. Commented text is highlighted, and clicking it shows the comment in the **Comments** panel, where you can reply, resolve or delete it.

Your `.tex` files are never touched. Comments are kept in `comments.opentex.json` in the project folder, so they travel with the folder (email, Dropbox, git) and never appear in the PDF. Each comment remembers the text it's on and the words around it:

- When you edit in OpenTex, comments move with the text.
- When a file is changed outside OpenTex (another editor, a collaborator, git), OpenTex finds each comment's text again.
- If a comment's text was rewritten or deleted, the comment is marked **Not found in the text**. Select the right text and click **Re-link** to attach it again.

Projects that used the older format (`%@comment` lines in the `.tex` files) are converted when you open them, and comments from Word documents come across the same way. Set your name once in Settings.

## Plugins

Plugins add panels you can place anywhere. Turn them on or off from the **Plugins** menu (or Settings → Plugins). Built in: **Forest Timer** (a Pomodoro timer with a growing pixel forest), **Lava Lamp** (a retro pixel lava lamp in several colors) and **Starship** (a pixel spaceship flying through space that speeds up the more you type). To write one, make a folder in the plugins folder (Settings → *Open plugins folder*) with:

- `plugin.json`: `{ "id": "my-plugin", "name": "My Plugin", "description": "…", "icon": "🔖", "panel": "index.html" }`
- `index.html`: an ordinary web page. Add `<script src="opentex-sdk.js"></script>` to get:
  - `OpenTex.onTheme(fn)`: the current theme (its colors are also set as CSS variables such as `--bg`, `--text`, `--accent`)
  - `OpenTex.onContext(fn)`: the open project, file and word count
  - `OpenTex.onActivity(fn)`: called while you type, with how many characters changed since the last call
  - `OpenTex.storage.get(key)` / `OpenTex.storage.set(key, value)`: saved between sessions
  - `OpenTex.notify(title, body)`: a system notification

Plugin pages run in a sandboxed frame. They can't read your files or reach the rest of OpenTex, only this API. See [`plugins/forest-timer`](plugins/forest-timer) for a complete example.

## Keyboard shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| New window | ⇧⌘N | Ctrl+Shift+N |
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
