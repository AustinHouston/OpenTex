// OpenTex plugin SDK. Include it in your panel page with:
//   <script src="opentex-sdk.js"></script>
// Your panel runs in a sandboxed frame. This file gives it a small, safe API:
//   OpenTex.onTheme(fn)          theme colors (also applied as CSS variables: --bg, --text, --accent, ...)
//   OpenTex.onContext(fn)        { project, file, words } whenever they change
//   OpenTex.storage.get(key)     Promise of a saved value (kept between sessions)
//   OpenTex.storage.set(key, v)  save a JSON-serializable value
//   OpenTex.notify(title, body)  show a system notification
;(function () {
  let nextId = 1
  const waiting = new Map()
  const themeFns = []
  const contextFns = []
  let theme = null
  let context = null
  const post = (msg) => parent.postMessage({ __opentex: true, ...msg }, '*')

  window.addEventListener('message', (e) => {
    const m = e.data
    if (!m || !m.__opentex) return
    if (m.type === 'theme') {
      theme = m.theme
      const root = document.documentElement.style
      for (const [k, v] of Object.entries(theme.colors)) root.setProperty(`--${k}`, v)
      for (const [k, v] of Object.entries(theme.syntax || {})) root.setProperty(`--syn-${k}`, v)
      document.documentElement.dataset.dark = String(theme.dark)
      themeFns.forEach((f) => f(theme))
    } else if (m.type === 'context') {
      context = m.context
      contextFns.forEach((f) => f(context))
    } else if (m.type === 'reply' && waiting.has(m.id)) {
      waiting.get(m.id)(m.value)
      waiting.delete(m.id)
    }
  })

  const request = (msg) =>
    new Promise((resolve) => {
      const id = nextId++
      waiting.set(id, resolve)
      post({ ...msg, id })
    })

  window.OpenTex = {
    onTheme(fn) {
      themeFns.push(fn)
      if (theme) fn(theme)
    },
    onContext(fn) {
      contextFns.push(fn)
      if (context) fn(context)
    },
    storage: {
      get: (key) => request({ type: 'storage:get', key }),
      set: (key, value) => post({ type: 'storage:set', key, value })
    },
    notify: (title, body) => post({ type: 'notify', title, body })
  }
  post({ type: 'ready' })
})()
