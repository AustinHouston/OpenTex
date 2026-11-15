// Lookup tables behind the plain-English error explanations (see rules.ts).
// Add to these freely: each entry is independent, and nothing else needs to change.

/** Which package defines a command (without the backslash). */
export const COMMAND_PACKAGES: Record<string, string> = {}
const provide = (pkg: string, names: string): void => {
  for (const n of names.split(/\s+/).filter(Boolean)) COMMAND_PACKAGES[n] ??= pkg
}
provide('siunitx', 'SI si num ang qty unit SIrange SIlist numrange numlist qtyrange qtylist qtyproduct numproduct tablenum sisetup DeclareSIUnit complexnum complexqty')
provide('graphicx', 'includegraphics graphicspath rotatebox scalebox resizebox reflectbox')
provide('booktabs', 'toprule midrule bottomrule cmidrule addlinespace specialrule')
provide('amssymb', 'mathbb mathfrak varnothing leqslant geqslant therefore because square blacksquare lesssim gtrsim checkmark nexists complement triangleq smallsetminus lll ggg eth Box Diamond')
provide('amsmath', 'text eqref tag dfrac tfrac binom dbinom tbinom boxed intertext substack overset underset xrightarrow xleftarrow iint iiint idotsint genfrac notag operatorname DeclareMathOperator numberwithin shoveleft shoveright allowdisplaybreaks smash cfrac')
provide('amsthm', 'theoremstyle qedhere qedsymbol newtheoremstyle')
provide('mathtools', 'coloneqq eqqcolon mathclap mathllap mathrlap prescript DeclarePairedDelimiter shortintertext')
provide('bm', 'bm')
provide('url', 'url urlstyle')
provide('hyperref', 'href hypersetup autoref nameref phantomsection texorpdfstring hyperlink hypertarget')
provide('xcolor', 'textcolor color colorbox fcolorbox definecolor pagecolor rowcolors rowcolor cellcolor')
provide('natbib', 'citep citet citealp citealt citeauthor citeyear citeyearpar Citet Citep Citeauthor setcitestyle bibpunct')
provide('biblatex', 'autocite parencite textcite footcite printbibliography addbibresource fullcite Textcite Parencite Autocite smartcite supercite cites')
provide('mhchem', 'ce cf')
provide('chemformula', 'ch')
provide('cleveref', 'cref Cref crefrange labelcref crefname Crefname')
provide('caption', 'captionof captionsetup')
provide('subcaption', 'subcaption subcaptionbox subref')
provide('subfig', 'subfloat')
provide('float', 'restylefloat floatstyle newfloat floatname')
provide('geometry', 'newgeometry restoregeometry geometry')
provide('setspace', 'doublespacing onehalfspacing singlespacing setstretch')
provide('multirow', 'multirow')
provide('array', 'newcolumntype')
provide('enumitem', 'setlist newlist setlistdepth')
provide('fancyhdr', 'fancyhf fancyhead fancyfoot lhead chead rhead lfoot cfoot rfoot')
provide('lipsum', 'lipsum')
provide('blindtext', 'blindtext Blindtext')
provide('todonotes', 'todo missingfigure listoftodos')
provide('soul', 'hl st so ul')
provide('ulem', 'uline uuline uwave sout xout')
provide('xspace', 'xspace')
provide('gensymb', 'degree celsius perthousand')
provide('tikz', 'tikz usetikzlibrary tikzset draw fill node coordinate')
provide('pgfplots', 'pgfplotsset addplot')
provide('listings', 'lstinline lstset lstinputlisting lstdefinestyle lstdefinelanguage')
provide('minted', 'mintinline inputminted setminted newminted')
provide('algpseudocode', 'State Require Ensure Procedure EndProcedure EndFor EndIf EndWhile Statex Comment')
provide('algorithm2e', 'SetAlgoLined KwIn KwOut KwData KwResult SetKwInOut')
provide('nicefrac', 'nicefrac')
provide('xfrac', 'sfrac')
provide('physics', 'dv pdv bra ket braket expval dd')
provide('upgreek', 'upmu upalpha upbeta upgamma updelta uppi uptau uplambda upOmega')
provide('pdfpages', 'includepdf')
provide('authblk', 'affil')
provide('orcidlink', 'orcidlink')
provide('lineno', 'linenumbers nolinenumbers')
provide('csquotes', 'enquote textquote blockquote')
provide('babel', 'selectlanguage foreignlanguage')
provide('makecell', 'makecell thead')
provide('threeparttable', 'tnote')
provide('xr', 'externaldocument')
provide('microtype', 'microtypesetup')
provide('textcomp', 'textdegree textcelsius textmu textohm textperthousand')
provide('amsfonts', 'mathbb')
provide('marvosym', 'Letter Mobilefone')
provide('wasysym', 'smiley frownie')
provide('pifont', 'ding')
provide('appendix', 'appendixpage')
provide('multicol', 'columnbreak')
provide('framed', 'FrameSep')
provide('fontawesome5', 'faGithub faEnvelope faTwitter faLinkedin')

/** Some commands come from more than one package; say so instead of naming just one. */
export const ALSO_FROM: Record<string, string> = {
  url: 'or hyperref, which also makes links clickable',
  mathbb: 'or amsfonts',
  citep: 'with biblatex, write `\\parencite` instead',
  citet: 'with biblatex, write `\\textcite` instead',
  cref: 'load it after hyperref',
  Cref: 'load it after hyperref',
  text: 'inside math, `\\mathrm{…}` works without it',
  degree: 'or write `$^\\circ$`'
}

/**
 * siunitx unit macros. These only exist inside \SI{..}{..}, \si{..}, \qty and \unit,
 * so "undefined" means siunitx is missing or the unit is outside those commands.
 */
export const SI_UNITS = new Set(
  ('meter metre second kilogram gram kelvin mole ampere candela hertz newton pascal joule watt volt ohm siemens farad coulomb ' +
    'tesla weber henry becquerel gray sievert lumen lux celsius degreeCelsius liter litre electronvolt bar angstrom dalton ' +
    'minute hour day percent arcminute arcsecond decibel bel neper tonne hectare astronomicalunit atomicmassunit ' +
    'yocto zepto atto femto pico nano micro milli centi deci deca deka hecto kilo mega giga tera peta exa zetta yotta ' +
    'per square squared cubic cubed tothe raiseto of ' +
    'm s kg g K mol A cd Hz N Pa J W V C F T mm cm km um nm pm fm ms us ns ps mg ug kHz MHz GHz kPa MPa GPa kJ kW MW mW ' +
    'mV kV mA uA nA mL uL ml ul L l eV keV meV MeV GeV mmol umol nmol kK dB fg ng pg Da kDa mT uT nT kN mN kOhm mOhm').split(' ')
)

/** Which package defines an environment. */
export const ENV_PACKAGES: Record<string, string> = {
  align: 'amsmath', 'align*': 'amsmath', gather: 'amsmath', 'gather*': 'amsmath', multline: 'amsmath', 'multline*': 'amsmath',
  flalign: 'amsmath', 'flalign*': 'amsmath', alignat: 'amsmath', 'alignat*': 'amsmath', split: 'amsmath', aligned: 'amsmath',
  gathered: 'amsmath', cases: 'amsmath', matrix: 'amsmath', pmatrix: 'amsmath', bmatrix: 'amsmath', Bmatrix: 'amsmath',
  vmatrix: 'amsmath', Vmatrix: 'amsmath', smallmatrix: 'amsmath', subequations: 'amsmath', 'equation*': 'amsmath',
  dcases: 'mathtools', 'dcases*': 'mathtools', proof: 'amsthm',
  subfigure: 'subcaption', subtable: 'subcaption', longtable: 'longtable', tabularx: 'tabularx',
  tabulary: 'tabulary', threeparttable: 'threeparttable', tablenotes: 'threeparttable',
  algorithm: 'algorithm', algorithmic: 'algpseudocode', algorithm2e: 'algorithm2e', lstlisting: 'listings', minted: 'minted',
  Verbatim: 'fancyvrb', comment: 'comment', tikzpicture: 'tikz', axis: 'pgfplots', wrapfigure: 'wrapfig', wraptable: 'wrapfig',
  landscape: 'pdflscape', sidewaysfigure: 'rotating', sidewaystable: 'rotating', multicols: 'multicol', 'multicols*': 'multicol',
  spacing: 'setspace', singlespace: 'setspace', doublespace: 'setspace', onehalfspace: 'setspace', framed: 'framed',
  mdframed: 'mdframed', tcolorbox: 'tcolorbox', 'enumerate*': 'enumitem', 'itemize*': 'enumitem', adjustbox: 'adjustbox',
  linenumbers: 'lineno', appendices: 'appendix', CJK: 'CJKutf8', otherlanguage: 'babel', refsection: 'biblatex'
}

/** Environments people usually define themselves with \newtheorem. */
export const THEOREM_LIKE = ['theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example', 'conjecture', 'claim', 'assumption', 'hypothesis', 'observation', 'exercise', 'problem', 'note']

/** Built-in environments, for spelling suggestions. */
export const KNOWN_ENVS = [
  'document', 'figure', 'figure*', 'table', 'table*', 'tabular', 'itemize', 'enumerate', 'description', 'abstract', 'center',
  'flushleft', 'flushright', 'equation', 'eqnarray', 'array', 'quote', 'quotation', 'verse', 'verbatim', 'minipage', 'thebibliography',
  'titlepage', 'math', 'displaymath', 'list', 'trivlist', 'picture', 'filecontents', ...Object.keys(ENV_PACKAGES), ...THEOREM_LIKE
]

/** Commands built into LaTeX (no package needed), for spelling suggestions. */
export const KERNEL_COMMANDS = (
  'textbf textit emph underline texttt textsc textrm textsf textsl textmd textup textnormal textsuperscript textsubscript ' +
  'section subsection subsubsection paragraph subparagraph chapter part caption label ref pageref cite nocite footnote ' +
  'footnotemark footnotetext item begin end documentclass usepackage title author date thanks maketitle tableofcontents ' +
  'listoffigures listoftables newpage clearpage cleardoublepage newline linebreak pagebreak nolinebreak nopagebreak ' +
  'noindent indent vspace hspace vfill hfill centering raggedright raggedleft small footnotesize scriptsize tiny large Large ' +
  'LARGE huge Huge normalsize bfseries itshape ttfamily mdseries upshape rmfamily sffamily scshape slshape normalfont input ' +
  'include includeonly bibliography bibliographystyle appendix today LaTeX TeX LaTeXe ldots dots cdots vdots ddots frac sqrt ' +
  'sum prod int oint lim infty partial nabla alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa ' +
  'lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi ' +
  'Sigma Upsilon Phi Psi Omega times cdot pm mp div ast star circ bullet leq geq neq approx equiv sim simeq cong propto ll ' +
  'gg subset supset subseteq supseteq in notin ni cup cap setminus emptyset forall exists neg land lor rightarrow leftarrow ' +
  'Rightarrow Leftarrow leftrightarrow Leftrightarrow longrightarrow to mapsto uparrow downarrow mathrm mathbf mathit mathcal ' +
  'mathsf mathtt mathnormal left right big Big bigg Bigg quad qquad hat widehat bar vec tilde widetilde dot ddot overline ' +
  'underline overbrace underbrace sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp max min sup inf det ' +
  'arg deg dim gcd hom ker lg Pr newcommand renewcommand providecommand newenvironment renewenvironment setlength ' +
  'addtolength setcounter addtocounter stepcounter newcounter value arabic roman Roman alph Alph fnsymbol hline cline ' +
  'multicolumn tabularnewline makebox mbox fbox framebox parbox raisebox rule phantom hphantom vphantom protect space ' +
  'enspace thinspace negthinspace smallskip medskip bigskip vskip hskip par newtheorem marginpar addcontentsline ' +
  'addvspace baselineskip textwidth linewidth columnwidth textheight paperwidth paperheight parindent parskip ' +
  'pagestyle thispagestyle pagenumbering numberline cdotp colon prime surd angle triangle aleph hbar ell wp Re Im ' +
  'imath jmath mathring acute grave check breve displaystyle textstyle scriptstyle limits nolimits stackrel overset ' +
  'boldmath unboldmath copyright dag ddag S P pounds textasciitilde textbackslash textbar textless textgreater ' +
  'textendash textemdash textquoteleft textquoteright guillemotleft guillemotright verb fontsize selectfont ' +
  'linespread footnoterule onecolumn twocolumn sloppy fussy hyphenation url'
).split(/\s+/)

/** Commands that only work inside a formula. */
export const MATH_ONLY = new Set(
  ('frac sqrt sum prod int oint iint lim infty partial nabla alpha beta gamma delta epsilon varepsilon zeta eta theta ' +
    'vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta ' +
    'Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega times cdot pm mp div leq geq neq le ge ne approx equiv sim simeq cong ' +
    'propto ll gg subset supset subseteq supseteq in notin cup cap setminus emptyset forall exists rightarrow leftarrow ' +
    'Rightarrow Leftarrow leftrightarrow to mapsto mathrm mathbf mathit mathcal mathsf mathbb mathfrak left right hat ' +
    'widehat bar vec tilde dot ddot overline overbrace underbrace sin cos tan log ln exp max min sup inf det binom dfrac ' +
    'tfrac mathbb boldsymbol operatorname cdots vdots ddots hbar ell nolimits limits displaystyle prime circ ast star bullet ' +
    'langle rangle lfloor rfloor lceil rceil lvert rvert mid parallel perp angle degree').split(' ')
)

/** Unicode characters pdfLaTeX can't typeset, and what to write instead. math: needs $…$. */
export const UNICODE: Record<string, { tex: string; math?: boolean; pkg?: string }> = {}
const uni = (math: boolean, pairs: string, pkg?: string): void => {
  for (const pair of pairs.trim().split(/\s+/)) {
    const [ch, tex] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
    UNICODE[ch] = { tex, math, pkg }
  }
}
uni(true, 'α=\\alpha β=\\beta γ=\\gamma δ=\\delta ε=\\varepsilon ϵ=\\epsilon ζ=\\zeta η=\\eta θ=\\theta ϑ=\\vartheta ι=\\iota κ=\\kappa λ=\\lambda ' +
  'μ=\\mu ν=\\nu ξ=\\xi π=\\pi ρ=\\rho σ=\\sigma ς=\\varsigma τ=\\tau υ=\\upsilon φ=\\varphi ϕ=\\phi χ=\\chi ψ=\\psi ω=\\omega ' +
  'Γ=\\Gamma Δ=\\Delta Θ=\\Theta Λ=\\Lambda Ξ=\\Xi Π=\\Pi Σ=\\Sigma Υ=\\Upsilon Φ=\\Phi Ψ=\\Psi Ω=\\Omega ' +
  '≤=\\leq ≥=\\geq ≠=\\neq ≈=\\approx ≡=\\equiv ∼=\\sim ≃=\\simeq ≅=\\cong ∝=\\propto ≪=\\ll ≫=\\gg ∞=\\infty ∂=\\partial ∇=\\nabla ' +
  '∑=\\sum ∏=\\prod ∫=\\int √=\\sqrt{} ∈=\\in ∉=\\notin ⊂=\\subset ⊆=\\subseteq ⊃=\\supset ∪=\\cup ∩=\\cap ∅=\\emptyset ∀=\\forall ' +
  '∃=\\exists →=\\rightarrow ←=\\leftarrow ↔=\\leftrightarrow ⇒=\\Rightarrow ⇐=\\Leftarrow ⇔=\\Leftrightarrow ↑=\\uparrow ↓=\\downarrow ' +
  '⋅=\\cdot ∘=\\circ ∗=\\ast ∓=\\mp ′=\\prime ″=\\prime\\prime ⟨=\\langle ⟩=\\rangle ∥=\\parallel ⊥=\\perp ∠=\\angle ℏ=\\hbar ℓ=\\ell ' +
  '−=- ∆=\\Delta Å=\\mathring{A} ⁰=^0 ¹=^1 ²=^2 ³=^3 ⁴=^4 ⁵=^5 ⁶=^6 ⁷=^7 ⁸=^8 ⁹=^9 ⁻=^- ₀=_0 ₁=_1 ₂=_2 ₃=_3 ₄=_4 ₅=_5 ₆=_6 ₇=_7 ₈=_8 ₉=_9')
uni(false, '✓=\\checkmark ✔=\\checkmark', 'amssymb')
uni(false, 'ﬁ=fi ﬂ=fl ﬀ=ff ﬃ=ffi ﬄ=ffl ‐=- ‑=- ‒=--')
// Invisible characters (usually pasted from Word or a PDF): remove or replace with a normal space.
export const INVISIBLE: Record<string, string> = { '​': '', '‌': '', '‍': '', '⁠': '', '﻿': '', ' ': '\\,', ' ': '\\,', ' ': ' ', ' ': '\\quad ', ' ': '~', ' ': ' ', ' ': '\\,', '­': '\\-' }

/** BibTeX styles that come with TeX, for spelling suggestions. */
export const BIB_STYLES = ['plain', 'unsrt', 'alpha', 'abbrv', 'acm', 'apalike', 'ieeetr', 'siam', 'plainnat', 'unsrtnat', 'abbrvnat', 'apsrev4-2', 'IEEEtran', 'naturemag', 'elsarticle-num', 'elsarticle-harv', 'achemso', 'aipnum4-2', 'aipauth4-2', 'rsc', 'vancouver', 'chicago', 'apacite']

/** Common package names, for spelling suggestions when a .sty file isn't found. */
export const KNOWN_PACKAGES = [
  ...new Set([...Object.values(COMMAND_PACKAGES), ...Object.values(ENV_PACKAGES)]),
  'inputenc', 'fontenc', 'lmodern', 'times', 'mathptmx', 'newtxtext', 'newtxmath', 'helvet', 'palatino', 'mathpazo', 'charter',
  'microtype', 'parskip', 'titlesec', 'tocloft', 'etoolbox', 'xparse', 'calc', 'ifthen', 'graphics', 'color', 'epstopdf',
  'sidecap', 'placeins', 'afterpage', 'footmisc', 'hyphenat', 'ragged2e', 'indentfirst', 'longtable', 'colortbl', 'hhline',
  'dcolumn', 'siunitx', 'textcomp', 'eurosym', 'upgreek', 'amsfonts', 'latexsym', 'stmaryrd', 'mathrsfs', 'esint', 'cancel',
  'empheq', 'chemfig', 'tikz', 'pgfplots', 'xr', 'xr-hyper', 'bookmark', 'natbib', 'biblatex', 'cite', 'apacite', 'datetime',
  'fancyvrb', 'verbatim', 'xspace', 'enumitem', 'ifpdf', 'fontspec', 'unicode-math', 'polyglossia', 'babel', 'csquotes'
]

/** LaTeX's internal command names (with @) as the author would know them. */
export const INTERNAL_NAMES: Record<string, string> = {
  'text@command': 'a text command such as `\\textbf`, `\\textit` or `\\emph`',
  '@xdblarg': 'a heading or caption such as `\\section{…}` or `\\caption{…}`',
  '@sect': 'a heading such as `\\section{…}`',
  '@caption': '`\\caption{…}`',
  '@footnotetext': '`\\footnote{…}`',
  '@xfootnote': '`\\footnote{…}`',
  'NR@setref': '`\\ref{…}`',
  '@citex': '`\\cite{…}`',
  'H@refstepcounter': 'a numbered item',
  '@tempa': 'a command'
}

/** Font series and shapes in plain words (from names like T1/ptm/bx/sc). */
export const FONT_SERIES: Record<string, string> = { m: 'regular', b: 'bold', bx: 'bold', sb: 'semibold', db: 'semibold', l: 'light', el: 'extra light', eb: 'extra bold', ub: 'ultra bold', c: 'condensed', mc: 'condensed', bc: 'bold condensed' }
export const FONT_SHAPES: Record<string, string> = { n: 'upright', it: 'italic', sl: 'slanted', sc: 'small caps', scit: 'italic small caps', scsl: 'slanted small caps', ui: 'upright italic', ol: 'outline' }
