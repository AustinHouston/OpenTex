---
name: OpenTex
description: A simple, reliable LaTeX editor that uses your local TeX installation.
colors:
  bg: "#ffffff"
  panel: "#f4f4f2"
  panelAlt: "#e8e8e4"
  border: "#dcdcd6"
  text: "#24292f"
  muted: "#6e7781"
  accent: "#2f6feb"
  accentText: "#ffffff"
  selection: "#cfe0ff"
  cursor: "#24292f"
  activeLine: "#f6f8fa"
  error: "#cf222e"
  warning: "#9a6700"
  pdfBg: "#e4e4e0"
  syn-command: "#8250df"
  syn-math: "#0a7b52"
  syn-env: "#0550ae"
  syn-comment: "#8c959f"
  syn-bracket: "#953800"
  syn-number: "#0550ae"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "34px"
    fontWeight: 650
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "28px"
    fontWeight: 600
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 550
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  body-small:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.04em"
  editor:
    fontFamily: "Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  math-glyph:
    fontFamily: "'Times New Roman', 'STIX Two Math', 'Cambria Math', serif"
    fontSize: "17px"
    fontWeight: 400
rounded:
  hairline: "2px"
  xs: "4px"
  sm: "5px"
  md: "6px"
  tile: "8px"
  dialog: "10px"
  bubble: "14px"
spacing:
  "2xs": "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  "2xl": "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accentText}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-ghost-hover:
    backgroundColor: "{colors.panelAlt}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  ribbon-button:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "3px 7px"
  ribbon-button-hover:
    backgroundColor: "{colors.panel}"
  ribbon-button-on:
    backgroundColor: "color-mix(in srgb, {colors.accent} 14%, {colors.bg})"
    textColor: "{colors.text}"
  toolbar-toggle-on:
    backgroundColor: "color-mix(in srgb, {colors.accent} 14%, {colors.panel})"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  ribbon-tab-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  input-text:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
  editor-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "6px 6px 0 0"
    height: "28px"
    padding: "0 6px 0 10px"
  editor-tab-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
  tree-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  tree-row-active:
    backgroundColor: "{colors.selection}"
  comment-card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
  panel-head:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    height: "32px"
---

# Design System: OpenTex

## Overview

**Creative North Star: "The Quiet Writing Desk"**

OpenTex is a calm, tidy desk. The paper is the brightest thing in the room: the editor sits on the pure background, the PDF page is a white sheet on a grey desk, and everything else (panels, ribbon, status bar) recedes into a slightly darker, warm-grey surface. Tools sit within reach and say what they are, but they don't compete with the writing. The playful parts, such as the pixel forest of Forest Timer or the plants of Writing Garden, are small things on the windowsill: they live inside their own panels and never leak into the chrome.

The chrome is native and restrained. It uses the operating system's own font at small sizes (13px body, 11px uppercase panel titles), flat surfaces separated by 1px lines, quiet hover tints, and a single accent color that marks the main action and the current selection. Density is that of a good desktop app, not a web page: 32px panel heads, 26px status bar, 3px-padded rows.

Every color is a theme variable. The same 14 interface keys and 6 syntax keys drive all 12 built-in themes (Light is the default) and any theme the user writes, so a design decision is only finished once it reads correctly in a dark theme and in High Contrast too.

It must not look like a web SaaS dashboard: no floating cards with soft shadows, no gradients, no big rounded pill buttons, no marketing hero layouts inside the app.

**Key Characteristics:**
- The paper (editor background and PDF page) is the lightest, calmest surface; chrome sits one step darker.
- System font, small sizes, uppercase letter-spaced labels for panel titles.
- Flat surfaces divided by 1px lines; shadows only on things that float above the window.
- One accent color per theme, used for the main action, selection and focus.
- Everything is a theme variable; nothing is hard-coded to the Light theme.
- Play is confined to plugin panels.

## Colors

A quiet, near-neutral palette with warm-grey chrome and a single clear blue accent (Light theme values; other themes swap every key).

### Primary
- **Compile Blue** (accent): the main action (Compile, Start focus), the 2px bar on top of the open ribbon tab, "on" rings, folder icons, focus outlines, splitter and drop-target highlights, links, and the comment bar in the text. Used sparingly enough that it always points at the one thing to do next.
- **On-Accent White** (accentText): text and icons placed on the accent, such as the Compile label and count badges.

### Neutral
- **Paper White** (bg): the writing surface: editor, active tab, ribbon body, inputs and comment cards. The brightest surface on screen.
- **Desk Grey** (panel): the chrome around the paper: panels, tab bar, ribbon tabs, dialogs, menus, status bar.
- **Pressed Grey** (panelAlt): hover and "on" states for rows, ghost buttons and toggles.
- **Hairline** (border): every 1px divider, input stroke and tile outline. The workspace background is this color, so the 1px gaps between panels read as lines.
- **Ink** (text): main text and the caret (cursor).
- **Pencil Grey** (muted): panel titles, secondary text, file paths, inactive tabs, idle icons.
- **Highlighter Blue** (selection): selected text and the selected file in the tree.
- **Current Line** (activeLine): a barely visible band behind the editor's current line.
- **Desk Under the Page** (pdfBg): the grey behind PDF pages, which are always white (#fff) with a small shadow regardless of theme.

### Status
- **Error Red** (error): compile errors, PDF file icons, detached comments.
- **Note Amber** (warning): warnings, comment highlights in the text (tinted background plus underline), image file icons, the SyncTeX flash on the PDF.

### Syntax
- **Command Violet** (syn-command), **Math Green** (syn-math), **Environment Blue** (syn-env), **Comment Grey** (syn-comment), **Bracket Brown** (syn-bracket), **Number Blue** (syn-number). They color LaTeX in the editor and are reused for file-type icons and badges in the tree (tex = command, refs = math), so a file's color matches how its contents look.

### Derived Chrome Roles
Mixed in `styles.css` from each theme's own keys, so they resolve per theme:
- `--ui-label` (text 60% / muted): tab labels, Help and other words on chrome; passes 4.5:1 on panel.
- `--ui-icon` (text 25% / muted): toolbar and ribbon icons and carets at rest; quiet, but 3:1 on panel and bg.
- `--on-fill` (accent 14% on bg) and `--on-fill-chrome` (accent 14% on panel): the "on" tint of a tile or a toolbar toggle.

### Named Rules
**The Paper Is Brightest Rule.** The writing surface (bg) and the PDF page are the lightest, calmest surfaces. Chrome uses panel, never bg, unless it is part of the paper (the active tab, the ribbon body, an input).

**The One Accent Rule.** Each theme has one accent. Use it for the main action, selection, focus and "this is on"; never as decoration. Ribbon and toolbar icons are never accent (they use `--ui-icon`); the open ribbon tab is a 2px inset accent bar with a `--text` label. Tints of it come from `color-mix(in srgb, var(--accent) N%, transparent)` with N between 10% and 55%.

**The Theme Variable Rule.** UI code uses `var(--key)` and `var(--syn-key)` only. The only literal colors allowed are the white PDF page, black-alpha shadows and backdrops, and the fixed plugin-highlight hues in `styles.css`.

## Typography

**UI Font:** system-ui (with -apple-system, 'Segoe UI', sans-serif)
**Editor Font:** Menlo (with monospace), size and line height user-adjustable
**Math Glyphs:** 'Times New Roman' (with 'STIX Two Math', 'Cambria Math', serif), only for symbol and equation previews

**Character:** The interface speaks in the operating system's own voice, so OpenTex feels like a Mac app on a Mac and a Windows app on Windows. The monospace editor and the serif math glyphs are the only other voices, and each belongs to the paper, not the chrome.

### Hierarchy
- **Display** (650, 34px, -0.01em): the app name on the welcome page only.
- **Headline** (600, 28px): rare top-level headings on full-window states.
- **Title** (550, 14px): welcome-page actions and recent project names; dialog emphasis.
- **Body** (400, 13px, line height 1.4): the default for all chrome, menus, dialogs and buttons.
- **Body small** (400, 12px): status bar, problems list, comment cards, hints and notes. The most used size in the app.
- **Label** (400–600, 11px, 0.04em, uppercase): panel titles, side and dock tabs, settings section heads. Ribbon tile labels use 11px without uppercase.
- **Editor** (400, 14px, line height 1.6): LaTeX source, logs, kbd keys and comment context lines.

### Named Rules
Chrome sizes come from three tokens: `--type-body` 13px, `--type-small` 12px, `--type-label` 11px (with `--lh-label` 1.15). 11px is the floor. Carets and icon-like marks are drawn SVG, not glyphs. Numbers that change (zoom, page count, status bar) use tabular numerals. Tile labels sit on one line; the tile grows to fit them. Ribbon tabs reserve their bold width, so opening one never shifts its neighbours.

**The Small and Native Rule.** Chrome text stays between 11px and 14px in the system font. Anything larger belongs to the welcome page or to the paper.

**The Uppercase Is for Panels Rule.** Uppercase, letter-spaced 11px text means "this is the name of a panel or a section". Don't use it for buttons or content.

## Layout

The window is a column: toolbar (42px, three groups: project, build, view), ribbon (a tab row plus a 52px body of 44px tiles, collapsible and hideable), the workspace, and the status bar (26px). The workspace is a free layout positioned by `layout.ts`: panels (Project, Files, PDF, Comments, Outline, Search, Problems, plugins) sit in rows and columns separated by 1px gaps that show the border-colored workspace behind them. Splitters sit over those gaps and tint with the accent on hover.

Each panel has a 32px head (drag handle, collapse arrow, title, extras, hide) and a body. A panel collapsed inside a row becomes a thin strip with a vertical title. File windows ("Files") carry their own 34px tab bar.

Spacing runs on a tight 2/4/6/8/12/16/20px rhythm: 4px gaps inside button groups, 8–12px horizontal padding in rows and heads, 16–20px in dialogs. Default sizes: Project sidebar 240px, PDF column 38%, dock 300px, each with a minimum width (140–220px).

Responsive behavior is about narrow windows, not phones: the ribbon scrolls sideways with a 4px scrollbar, tiles drop their labels in steps (Design names below 1100px, Insert's last group below 1000px, all of Insert below 880px, every tab below 760px), anything still too wide fades at its edge, and the welcome page's two columns stack below 760px.

Focus mode removes everything except the focused file window, centers the text at 80ch with generous top and bottom padding (18vh / 45vh), and hides gutters and comment marks.

## Elevation & Depth

The window is flat. Panels, tabs, the ribbon and the status bar sit on one plane and are told apart by tone (bg vs panel vs panelAlt) and 1px lines. Shadows appear only on things that float above the window, and they are neutral black at low opacity so they work in every theme.

### Shadow Vocabulary
- **Page** (`box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25)`): PDF pages on the desk.
- **Bubble** (`box-shadow: 0 3px 12px rgba(0,0,0,0.25)`): the floating + Comment bubble.
- **Drag ghost** (`box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2)`): the label that follows a dragged panel or tab.
- **Menu** (`box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25)`): context menus and hover cards.
- **Popover** (`box-shadow: 0 10px 32px rgba(0, 0, 0, 0.22)`): Insert drop-downs (table, equation, symbol, figure).
- **Dialog** (`box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3)`, backdrop `rgba(0, 0, 0, 0.3)`): modal dialogs.

### Named Rules
**The Only Floaters Cast Shadows Rule.** If it is docked in the layout, it is flat. Shadows are for pages, menus, popovers, dialogs, bubbles and drag ghosts, in that vocabulary and nowhere else.

**The Inset for State Rule.** "Selected" and "flash" states use inset or outline rings in the accent (`inset 0 0 0 1px var(--accent)`, a 3px accent left bar), not drop shadows. "On" (a toggle, a chosen preset, an open popover's tile, Fit width in the PDF head) is the 14% accent tint plus a 1px accent ring; the ring carries the 3:1. Hover never uses the accent: it is panel or panelAlt and text-colored ink. Every control's keyboard focus is a 2px accent outline (`:focus-visible`).

## Shapes

Gently rounded, small radii throughout. Buttons, inputs, selects, comment cards and drop previews use 6px; ribbon tiles use 6px (mini tools 5px); theme and template cards, menus and welcome actions use 8px; tree rows 5px; badges, kbd keys and tab close buttons 4px; text highlights 2px. Only things that float get more: dialogs and Insert popovers 10px, the comment bubble 14px with a small downward pointer. Outlines are 1px in the border color; a selected card swaps its outline to the accent (2px on choice cards). Comment cards and in-text comment lines carry a 3px accent bar on the left, the one place a thick stroke appears.

Icons are hand-drawn line SVGs: 18px by default (14–20px in context), no fill, 1.5px round-capped strokes in currentColor.

## Components

### Buttons
Quiet by default; only the main action is filled.
- **Shape:** gently rounded (6px), 4px 10px padding, 1px transparent border.
- **Primary:** accent background, accentText label, weight 600, an optional 14px filled icon with a 6px gap. Used for Compile and the confirming action in a dialog. Hover brightens it slightly (`filter: brightness(1.08)`); busy drops it to 70% opacity.
- **Ghost (default):** no background; hover fills it with panelAlt. Used for nearly every toolbar and panel action.
- **Icon:** ghost button with muted icon color, turning to text color on hover or when on.
- **Secondary:** panel background with a 1px border; used on the welcome page and as the non-primary dialog action.
- **Link:** accent-colored text, 2px 6px padding; for inline actions such as Reply, Resolve, Delete.

### Ribbon Tab Row
Content tabs File, Insert, Design, Citations, Review form a `role=tablist` (arrow keys, Home and End move between them; only the open tab is in the Tab order). Then Settings, styled as a tab but a plain button that opens the Settings window. At the right end: a Help menu (Report a Bug, Suggest a Feature, See All Issues on GitHub, How to Make a Plugin, Open the Example Paper, Check for Updates; items that open the browser say so in their tooltip) and a chevron that collapses the ribbon. Clicking the open tab collapses it too. Plugins are switched in Settings → Plugins. The open tab takes the paper background, a semibold `--text` label and a 2px inset accent bar on top; the others use `--ui-label`.

### Ribbon Tiles
The ribbon is the one place controls are labelled tiles, kept restrained: one tile family on the paper background with a 1px border and 6px corners, 44px tall and only as wide as its content: an 18px icon in `--ui-icon` over a one-line 11px label, with 8px side padding (11px when it carries a caret). Tools that are a single mark (x² and x₂, B and I, the two lists) are 26×21 mini tiles stacked two to a column, so each pair is exactly one tile tall. Design presets put a 22×28 page thumbnail beside a one-line name. Hover moves to the panel tone with a text-tinted border and text-colored icon; on uses `--on-fill` with an accent border; keyboard focus shows a 2px accent outline. Tiles that open a menu or popover carry a drawn caret and `aria-expanded`; Escape closes them and returns the focus to the tile. Tiles in a group are 3px apart; groups are separated by a 32px hairline. **The Fit the Content Rule.** A ribbon button is no bigger than its icon and label need and no smaller than a comfortable target: no fixed widths, no empty two-line slots, no lone glyph in a big box.

### Toolbar
Icon buttons (project files, PDF, focus mode, panels) are `--ui-icon` at rest, text and panelAlt on hover, and when on take `--on-fill-chrome` with a 1px accent ring and `aria-pressed`. Each has an `aria-label`. Panels is a 2×2 grid of panes with a caret; the PDF toggle is a drawn "PDF" badge.

### Inputs / Fields
- **Style:** paper background, 1px border, 6px corners, 5px 8px padding, full width. Selects match at 3px 6px.
- **Focus:** the operating system's focus ring; no custom glow.

### Navigation: Tabs, Tree and Panel Heads
- **Editor tabs:** folder tabs that belong to their file window: 28px tall with 6px top corners, set 4px below the panel head on the panel tone and standing on the editor's top edge. Inactive tabs are borderless `--ui-label` text (panelAlt on hover); the open tab takes the paper background, a 1px border on three sides and no bottom edge, so it runs straight into the text. They must never read as a second bar to grab: the panel head is the only drag handle. A dirty file shows a dot in place of the close icon until hovered.
- **File tree:** 3px 8px rows with 5px corners; hover panelAlt, selected file in the selection color. File-type icons and small outlined badges (10px, 4px corners) use syntax and status colors: main in accent, tex in command violet, refs in math green, pdf in error red, images in amber.
- **Panel heads:** 32px, 11px uppercase muted label, drag cursor, with collapse and hide buttons at 14px. The PDF head reads − 45% + [Fit width] 3 pages: drawn minus and plus, the real percentage always, and Fit width shown as on while the zoom follows the panel.

### Comment Cards
Paper background, 1px border plus a 3px accent left bar, 6px corners, 8px 10px padding, 12px text. Meta line in 11px muted with the author in bold text color; replies are indented behind a 2px border line; the quoted text is italic with an amber bar; actions are small accent links. Resolved cards drop to 60% opacity with a muted bar; detached ones turn the bar red. In the text, commented passages get an amber tint with an amber underline, like a highlighter.

### Dialogs and Popovers
Panel background, 1px border, 10px corners, dialog shadow; body padding 18px 20px; actions right-aligned with 8px gaps. Settings use a two-column grid (170px labels). Insert popovers share the look with their own widths (230–400px) and 11px uppercase section heads.

### Status Bar
26px, 12px muted text, 14px gaps, top hairline. Errors turn red and are clickable; warnings amber.

### Welcome Page
The one full-window composition: an 860px column, the 76px app icon beside the 34px display name and a 16px muted tagline, then two columns (actions, recent projects) with 12px uppercase section heads. Actions are 8px-rounded rows with a 20px accent icon, a 14px title and a 12px muted description.

## Do's and Don'ts

### Do:
- **Do** reference every color through `var(--key)` or `var(--syn-key)` and check new UI in Light, a dark theme and High Contrast.
- **Do** keep the paper (bg) and the PDF page as the brightest, calmest surfaces; chrome uses panel.
- **Do** separate docked areas with 1px border lines and tone, not shadows.
- **Do** keep chrome text in the system font at 11–14px, with 11px uppercase letter-spaced (0.04em) labels for panel names.
- **Do** reserve the filled accent button for the single main action in a view.
- **Do** use the existing radii: 6px for controls and ribbon tiles, 8px for cards, 10px only for floating dialogs and popovers.
- **Do** draw icons as 1.5px-stroke line SVGs in currentColor.
- **Do** keep playful, illustrated or pixel-art content inside plugin panels.

### Don't:
- **Don't** make it look like a web SaaS dashboard: no floating cards with soft shadows, no gradients, no big rounded pill buttons, no hero layouts inside the app.
- **Don't** add drop shadows to docked panels, tabs or ribbon tiles.
- **Don't** hard-code Light theme hex values in UI code.
- **Don't** use the accent as decoration or for more than one competing action per view.
- **Don't** introduce web fonts for the chrome; the system font is the interface's voice.
