// Makes a realistic test paper for the benchmark: a main file, 8 sections (~3,000 lines in all),
// 10 figures, 120 references, equations, citations, cross-references and a few comments.
//   node scripts/bench/make-project.mjs <folder>
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const out = path.resolve(process.argv[2] ?? 'bench-paper')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'sections'), { recursive: true })
fs.mkdirSync(path.join(out, 'figures'), { recursive: true })

let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const words = 'detector signal electron beam sample measurement noise model timing resolution pixel cluster energy spectrum calibration analysis method result figure table we show that the of and in to with for by is are was were this these our data each across within between under over through while when'.split(' ')
const sentence = (cite, ref) => {
  const n = 9 + Math.floor(rnd() * 14)
  const w = Array.from({ length: n }, () => pick(words))
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  let s = w.join(' ')
  if (rnd() < 0.25) s += ` \\cite{ref${1 + Math.floor(rnd() * 120)}}`
  if (rnd() < 0.12) s += `, as in Figure~\\ref{fig:${1 + Math.floor(rnd() * 10)}}`
  if (rnd() < 0.15) s += ` with $\\sigma_${Math.floor(rnd() * 9)} = ${(rnd() * 10).toFixed(2)}\\,\\mathrm{ns}$`
  return s + '.'
}

const png = path.join(repo, 'templates/example-paper/figures/example-plot.png')
const names = ['introduction', 'background', 'theory', 'methods', 'simulation', 'results', 'discussion', 'conclusions']
let fig = 0
let eq = 0
names.forEach((name, i) => {
  const lines = [`\\section{${name[0].toUpperCase() + name.slice(1)}}\\label{sec:${name}}`, '']
  while (lines.length < 370) {
    const k = rnd()
    if (k < 0.05 && fig < 10) {
      fig++
      fs.copyFileSync(png, path.join(out, 'figures', `fig${fig}.png`))
      lines.push('\\begin{figure}[htbp]', '\\centering', `\\includegraphics[width=0.7\\linewidth]{figures/fig${fig}}`, `\\caption{${sentence()}}`, `\\label{fig:${fig}}`, '\\end{figure}', '')
    } else if (k < 0.12) {
      eq++
      lines.push('\\begin{equation}', `  E_{${eq}} = \\frac{1}{N}\\sum_{i=1}^{N} \\left( x_i - \\mu \\right)^2 + \\int_0^\\infty e^{-t/\\tau}\\,dt`, `  \\label{eq:${eq}}`, '\\end{equation}', '')
    } else if (k < 0.16) {
      lines.push(`\\subsection{Part ${lines.length}}`, '')
    } else {
      for (let s = 0; s < 3 + Math.floor(rnd() * 4); s++) lines.push(sentence())
      lines.push('')
    }
  }
  fs.writeFileSync(path.join(out, 'sections', `${name}.tex`), lines.join('\n'))
})
while (fig < 10) {
  fig++
  fs.copyFileSync(png, path.join(out, 'figures', `fig${fig}.png`))
  fs.appendFileSync(path.join(out, 'sections', 'results.tex'), `\n\\begin{figure}[htbp]\\centering\\includegraphics[width=0.6\\linewidth]{figures/fig${fig}}\\caption{Extra.}\\label{fig:${fig}}\\end{figure}\n`)
}
const bib = Array.from({ length: 120 }, (_, i) => `@article{ref${i + 1},\n  author = {Author${i}, A. and Other, B.},\n  title = {A study of ${pick(words)} ${pick(words)} number ${i + 1}},\n  journal = {Journal of Tests},\n  year = {${1990 + (i % 35)}},\n  volume = {${i % 50}},\n  pages = {${i}--${i + 9}},\n  doi = {10.1000/test.${i + 1}}\n}`).join('\n\n')
fs.writeFileSync(path.join(out, 'refs.bib'), bib + '\n')
fs.writeFileSync(
  path.join(out, 'main.tex'),
  `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}
\\title{Benchmark paper}
\\author{OpenTex}
\\begin{document}
\\maketitle
\\begin{abstract}
${sentence()} ${sentence()}
\\end{abstract}
${names.map((n) => `\\input{sections/${n}}`).join('\n')}
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`
)
const intro = fs.readFileSync(path.join(out, 'sections/introduction.tex'), 'utf8')
const threads = [12, 40, 90, 150, 220].map((ln, i) => {
  const lines = intro.split('\n')
  const pos = lines.slice(0, ln).join('\n').length + 1
  const quote = lines[ln].slice(0, 30)
  return { id: `cbench${i}`, file: 'sections/introduction.tex', quote, prefix: intro.slice(Math.max(0, pos - 40), pos), suffix: intro.slice(pos + quote.length, pos + quote.length + 40), pos, author: 'Bench', date: '2026-11-15', text: 'A benchmark comment.', replies: [], resolved: false }
})
fs.writeFileSync(path.join(out, 'comments.opentex.json'), JSON.stringify({ version: 1, threads }, null, 2))
const total = names.reduce((n, s) => n + fs.readFileSync(path.join(out, 'sections', `${s}.tex`), 'utf8').split('\n').length, 0)
console.log(`Made ${out}: ${total} lines in 8 sections, 10 figures, 120 references, ${eq} equations, 5 comments`)
