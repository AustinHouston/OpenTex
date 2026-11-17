# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

OpenTex is a desktop app for macOS and Windows (a Linux AppImage target also exists), built with Electron. Its interface is HTML/CSS/TypeScript in `src/renderer/`, so its design language is web, not native iOS or Android. The download page in `docs/` (served at https://austinhouston.github.io/OpenTex/) is a separate web surface.

## Users

OpenTex serves three groups equally; none is primary:

- **People coming from Word.** Scientists, students and staff who write papers but find LaTeX intimidating. They expect a ribbon, comments, Word import and export, and errors they can understand.
- **Researchers on managed computers.** Lab and government staff who can't use cloud editors or install software that needs an administrator, and who share papers with co-authors by email, Dropbox or git.
- **Experienced LaTeX writers.** People who know LaTeX and want a fast, local editor that stays out of the way.

The job in every case is the same: write a paper, compile it, see the PDF beside the text, and exchange it with co-authors and journals.

## Product Purpose

OpenTex is a simple, reliable LaTeX editor for writing papers. It opens one project folder at a time, compiles with the user's own TeX installation, and shows the PDF beside the text. Success is a writer who stays focused on the paper: it compiles, errors explain themselves, nothing is lost, and collaborators can use whatever tools they like.

## Positioning

Confirmed differentiators against Overleaf, TeXstudio and VS Code:

1. **Local and private.** It uses the TeX on the user's computer, keeps every file in the user's own folder, and sends nothing to a server. It works offline and behind institutional firewalls.
2. **Simple and reliable.** Sensible defaults, few settings, errors in plain English with one-click fixes, autosave and version history. It just compiles.
3. **Pleasant to write in.** Focus mode, themes, live preview, and playful plugins such as Writing Garden and Forest Timer make writing enjoyable rather than merely tolerable.

Word-like familiarity (the ribbon, Word-style comments, Word round-tripping) is a real feature set but was not chosen as a defining differentiator.

## Operating Context

- Work happens in a plain project folder: `.tex` files, `.bib` files, figures, plus small OpenTex sidecars that travel with the folder (`comments.opentex.json`, `<project>/.opentex/project.json`).
- Collaboration is out of band. Co-authors edit the same folder through email, Dropbox or git, and OpenTex notices changes on disk and reloads.
- Papers move in and out through Word (`.docx` import via Pandoc, Word export), reference managers (EndNote XML, Zotero/Mendeley BibTeX or RIS, CSL JSON), DOIs and arXiv IDs, and Review PDFs for co-authors and supervisors who only read and print.
- Writers often work for long stretches, sometimes on battery. Live preview runs at low priority, waits longer on battery and pauses when hidden.
- Installation and first run happen on unsigned builds today, so users meet macOS and Windows security prompts, and managed machines may need IT approval.

## Capabilities and Constraints

Capabilities in the shipped app (v0.4.2), per README.md:

- Welcome page with recent folders, New Project (blank or the example paper), Open Folder and Import Word; multiple windows, one folder each.
- CodeMirror 6 editor with LaTeX highlighting, autocomplete for citations, labels, environments and commands, spellcheck that ignores commands and math, and live word count.
- Compile with latexmk or an engine directly, compile-on-save, live preview of unsaved text, SyncTeX both ways, and a pdf.js viewer that keeps its place.
- Errors and warnings explained in plain English with one-click fixes.
- A ribbon with File, Insert, Design, Citations and Review tabs, a Settings button styled as a tab, and a Help menu and collapse chevron at the right end (plugins are switched in Settings → Plugins). Design switches the whole paper among Article, Nature-, Science-, Physical Review-style, IEEE and Review draft presets and keeps the user's own setup as Custom.
- A free layout: panels (Project, Files, PDF, Comments, Outline, Search, Problems, plugin panels) can be split, swapped, resized, collapsed and hidden, with several file windows.
- Word-style comments, file management with reference updates, Find in Project, an outline with word counts, pasting pictures and spreadsheet cells, history and Changes Since, focus mode, 12 themes plus user themes, interface zoom.
- Plugins as sandboxed web pages that get only the OpenTex SDK (theme, context, activity, storage, notify).
- One-click TinyTeX install and on-demand package install; Pandoc download on first Word import.

Current behavior worth keeping in mind (documented, but the user has not declared these binding rules):

- Installs and downloads (OpenTex itself, TinyTeX, Pandoc) need no administrator rights.
- Bug reports and update checks send no names, file paths or paper text. Updates are announced, never installed automatically.
- `.tex` files are only written by Save or Autosave; previews, review PDFs and exports work on temporary copies.

Terminology used in the product: *project folder*, *main file*, *Compile*, *live preview*, *ribbon*, *panel*, *file window*, *Design* presets, *Review PDF*, *focus mode*, *plugin*.

Undecided: no accessibility standard, copy rules or other binding constraints were set during init.

## Brand Commitments

- The name **OpenTex** and its icon (`build/icon.png`, drawn by `scripts/make-icon.cjs`; also `docs/icon.png`) are protected by TRADEMARKS.md. Changed versions need their own name and icon.
- Code is AGPL-3.0-or-later (MIT up to and including v0.4.2).
- Voice, as written in README.md: short, concrete, plain-English sentences that say what happens and where, with menu paths and shortcuts spelled out. This is the existing voice, not a rule the user has made binding.

## Evidence on Hand

- README.md: full feature list, install guidance, keyboard shortcuts, plugin SDK.
- `templates/`: the example paper and blank project.
- `plugins/`: built-in Forest Timer, Lava Lamp, Starship, Writing Garden and Readability, plus `opentex-sdk.js`.
- `docs/index.html`, `docs/style.css`, `docs/img/`: the download page and its images.
- `scripts/bench/`: a compile and preview benchmark (for example, about half a second per live-preview pass on a 70-page paper, per the README).
- Absent: no user testimonials, case studies, usage numbers, press, named institutional users or download counts. Future work must not invent them.

## Product Principles

1. **The paper stays the user's.** Files live in the user's folder, in plain formats other tools can read, and nothing leaves the machine without the user asking.
2. **It should just work.** Prefer a sensible default and a clear explanation over another setting or a cryptic message.
3. **Serve the beginner and the expert at once.** Help appears when it's needed and gets out of the way when it isn't; experienced writers are never slowed down.
4. **Writing should feel good.** Calm, focused, a little playful, without ever getting between the writer and the text.
5. **Never lose work.** Autosave, history, recovery and temporary copies come before speed or cleverness.
