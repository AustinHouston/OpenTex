# Benchmark results

Measured with `scripts/bench/bench.mjs` on a MacBook (Apple silicon, macOS 26, BasicTeX 2026) on a
generated 3,000-line paper (8 sections, 10 figures, 120 references), fresh profile each run.
"Before" is commit 5a69ff8 (v0.3.2 plus the ten features from November 15); "after" adds live
preview, hover previews, Review PDF, the Writing Garden and the lighter plugins. CPU is the sum of
all OpenTex processes; about 1.5% of the idle figure is the editor's blinking cursor.

| | Before | After |
|---|---|---|
| Start-up (launch → start page) | 0.49 s | 0.45–0.52 s |
| Open the paper | 0.05 s | 0.06 s |
| Keypress → on screen (median / 95th percentile) | 9.3 / 17.8 ms | 10.0 / 17.7 ms |
| Stalls over 50 ms while typing | 0 | 0 |
| Scrolling (95th percentile frame, frames over 33 ms) | 17.7 ms, 0 | 17.7 ms, 0 |
| CPU at rest, new install | 25.7% (all four plugin panels open) | 3.1% (plugins start hidden) |
| Memory, new install | 859 MB | 519 MB |
| CPU while typing | 17.1% | 8.9% app + 9.7% background TeX (live preview) |
| CPU 10–20 s after typing stops | – | 1.3% |
| Full compile | 6.4 s | 6.2 s |

**Live preview** (on by default): background build 0.47 s, last keystroke → updated PDF 1.25 s,
one TeX pass per build, typing 95th percentile 17.4 ms while PDFs swap, no stalls.

**Hover previews**: 18–20 ms from hover to preview on screen (after the 300 ms hover delay),
36 ms the first time math is hovered (KaTeX loads then, not at start-up). No stalls.

**Review PDF**: no cost unless used. 7.9 s to export the 68-page paper with comments and changes.

**Plugins**, CPU at rest with that panel open (plain app with no plugin open: 2.9%):

| Plugin | Before | After |
|---|---|---|
| Forest Timer | 14.8% | 2.9% |
| Starship | 9.1% | 5.9% |
| Lava Lamp | 7.7% | 4.5% |
| Readability | 3.0% | 2.7% |
| Writing Garden (new) | – | 2.6% |

Each open plugin also adds one browser process of about 100 MB.
