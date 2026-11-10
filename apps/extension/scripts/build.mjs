/**
 * Builds the extension for each browser: `dist/firefox/` and `dist/chrome/`, which are what the
 * browsers load.
 *
 * The extension pages and the background are ES modules that import `@delta/core`, which a
 * browser cannot resolve, so each entry is bundled by esbuild. Everything else (HTML, CSS, icons,
 * vendored KaTeX and the classic scripts the manifest and pages load directly, such as the content
 * scripts) is copied as it is. `manifest.json` is written for Firefox; the Chrome build derives its
 * own (`chromeManifest`) and adds the WebExtension polyfill, which defines `browser.*` there.
 *
 *   node scripts/build.mjs                    both browsers, once
 *   node scripts/build.mjs --watch            both browsers into dist/dev/, rebuilt on every change
 *   node scripts/build.mjs --browser=chrome   one browser (with or without --watch)
 *
 * A watch build also reloads the extension after every rebuild: the background loads
 * `src/dev/auto-reload.js` (`DEV_BACKGROUND`), which listens on the WebSocket `serveReloads`
 * opens on 127.0.0.1 (`DELTA_RELOAD_PORT`, default 35730). A release build has neither.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watching = process.argv.includes('--watch')
const reloadPort = Number(process.env.DELTA_RELOAD_PORT) || 35730
const only = process.argv.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length)

/**
 * Each browser's output directory and esbuild target. A watch build writes to `dist/dev/`, so a
 * release build (`npm run verify` runs one) never replaces the build a browser has loaded for
 * development with one that lacks the self-reload files, nor the other way round.
 */
const distDir = watching ? join(root, 'dist', 'dev') : join(root, 'dist')
const TARGETS = {
  firefox: { out: join(distDir, 'firefox'), esbuild: 'firefox140' },
  chrome: { out: join(distDir, 'chrome'), esbuild: 'chrome120' }
}

/** Where the Chrome build ships the polyfill for its content scripts. */
const POLYFILL_SCRIPT = 'vendor/browser-polyfill.min.js'
const polyfillSource = join(
  dirname(createRequire(import.meta.url).resolve('webextension-polyfill')),
  'browser-polyfill.min.js'
)

/** Chrome reads no SVG icons. */
const PNG_ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png'
}

/** Module entry points: everything they import is bundled into them. */
const ENTRIES = ['background.js', 'popup/popup.js', 'dashboard/js/app.js', 'canvas/canvas.jsx']

/**
 * Watch builds only: the self-reload module, the background that loads it after the real one, and
 * the content script automation drives the page with (see each file).
 */
const DEV_RELOAD_ENTRY = 'src/dev/auto-reload.js'
const DEV_BACKGROUND = 'dev-background.js'
const DEV_CONTENT_SCRIPT = 'src/dev/page-hooks.js'

/** Stylesheets that import others (the shared canvas's, KaTeX's): bundled, never copied as they are. */
const CSS_ENTRIES = ['canvas/canvas-ui.css']

/** Never shipped: tooling, docs, build output, the manifest (written per browser) and Chrome's shim. */
const SKIPPED = new Set([
  'dist',
  'node_modules',
  'scripts',
  'docs',
  'package.json',
  'manifest.json',
  '.gitignore'
])
const SKIPPED_PATHS = new Set(['src/chrome'])

const posix = (path) => path.split(sep).join('/')

/** Scripts loaded without `type="module"`: content scripts and the pages' classic scripts. */
function classicScripts() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
  const scripts = new Set(manifest.content_scripts.flatMap((entry) => entry.js ?? []))
  if (watching) scripts.add(DEV_CONTENT_SCRIPT)
  for (const page of ['popup/popup.html', 'dashboard/dashboard.html', 'canvas/canvas.html']) {
    const html = readFileSync(join(root, page), 'utf-8')
    for (const [tag, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
      if (!/type="module"/.test(tag)) scripts.add(posix(join(dirname(page), src)))
    }
  }
  return scripts
}

function shipped(path, classic) {
  const rel = posix(relative(root, path))
  const top = rel.split('/')[0]
  if (SKIPPED.has(top) || SKIPPED_PATHS.has(rel)) return false
  if (rel.endsWith('.md') || rel.endsWith('.jsx')) return false
  if (CSS_ENTRIES.includes(rel)) return false
  return !rel.endsWith('.js') || classic.has(rel)
}

/**
 * Chrome never assigns a suggested key that is one of its own shortcuts, such as Ctrl+E (pages take
 * that key themselves there, see src/content/init.js) or Alt+Shift+C.
 */
const CHROME_SUGGESTED_KEYS = { expand: null, 'open-canvas': 'Alt+Shift+V' }

function chromeCommands(commands) {
  const result = structuredClone(commands)
  for (const [name, key] of Object.entries(CHROME_SUGGESTED_KEYS)) {
    if (!result[name]) continue
    if (key) result[name].suggested_key = { default: key }
    else delete result[name].suggested_key
  }
  return result
}

/**
 * Chrome's manifest: a module service worker instead of an event page, PNG icons, no Gecko
 * settings, and the polyfill ahead of every content script.
 */
function chromeManifest(manifest) {
  const rest = { ...manifest }
  delete rest.browser_specific_settings
  return {
    ...rest,
    minimum_chrome_version: '120',
    background: { service_worker: manifest.background.scripts[0], type: 'module' },
    content_scripts: manifest.content_scripts.map((entry) => ({
      ...entry,
      js: [POLYFILL_SCRIPT, ...(entry.js ?? [])]
    })),
    commands: chromeCommands(manifest.commands),
    action: { ...manifest.action, default_icon: PNG_ICONS },
    icons: PNG_ICONS
  }
}

/**
 * Points the background at `DEV_BACKGROUND`, written next to it, which imports both modules, and
 * appends `DEV_CONTENT_SCRIPT` to the content scripts.
 */
function withDevFiles(manifest, out) {
  const background = manifest.background.scripts[0]
  writeFileSync(
    join(out, DEV_BACKGROUND),
    `import './${background}'\nimport './${DEV_RELOAD_ENTRY}'\n`
  )
  return {
    ...manifest,
    background: { ...manifest.background, scripts: [DEV_BACKGROUND] },
    content_scripts: manifest.content_scripts.map((entry) => ({
      ...entry,
      js: [...(entry.js ?? []), DEV_CONTENT_SCRIPT]
    }))
  }
}

function writeManifest(browser, out) {
  let manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
  if (watching) manifest = withDevFiles(manifest, out)
  const written = browser === 'chrome' ? chromeManifest(manifest) : manifest
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(written, null, 2) + '\n')
}

function copyStatic(browser, out) {
  const classic = classicScripts()
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (!shipped(path, classic)) continue
      if (entry.isDirectory()) visit(path)
      else {
        const target = join(out, relative(root, path))
        mkdirSync(dirname(target), { recursive: true })
        cpSync(path, target)
      }
    }
  }
  visit(root)
  writeManifest(browser, out)
  if (browser === 'chrome') {
    mkdirSync(dirname(join(out, POLYFILL_SCRIPT)), { recursive: true })
    cpSync(polyfillSource, join(out, POLYFILL_SCRIPT))
  }
}

async function bundler(browser, { out, esbuild }, plugins) {
  const entries = watching ? [...ENTRIES, DEV_RELOAD_ENTRY] : ENTRIES
  return context({
    absWorkingDir: root,
    entryPoints: [...entries, ...CSS_ENTRIES].map((entry) => ({
      in: entry,
      out: entry.replace(/\.(jsx?|css)$/, '')
    })),
    outdir: out,
    bundle: true,
    format: 'esm',
    target: esbuild,
    // Chrome has no `browser.*`: every bundle defines it before anything else runs.
    inject: browser === 'chrome' ? ['src/chrome/browser-global.js'] : [],
    // The canvas page renders the shared React UI (@delta/ui).
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify(watching ? 'development' : 'production'),
      __DELTA_RELOAD_PORT__: String(reloadPort)
    },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
    // Readable output: add-on review reads what ships.
    minify: false,
    sourcemap: watching ? 'linked' : false,
    legalComments: 'inline',
    logLevel: 'info',
    plugins
  })
}

/* ---- Self-reload (watch builds) ---- */

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEEP_AWAKE_MS = 20_000

/** One unmasked WebSocket text frame; the messages here are always short. */
function textFrame(text) {
  const payload = Buffer.from(text)
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}

/**
 * A send-only WebSocket server on 127.0.0.1. Each extension background that connects gets the
 * current build id at once and every new one after; a message every 20 s keeps Chrome's service
 * worker from idling out between rebuilds. Returns `announce(id)`.
 */
function serveReloads(port) {
  const sockets = new Set()
  let current = Date.now().toString(36)
  const send = (socket, message) => socket.write(textFrame(JSON.stringify(message)))
  const server = createServer((_request, response) => response.writeHead(426).end())
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (!key || request.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy()
    const accept = createHash('sha1')
      .update(key + WEBSOCKET_GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    sockets.add(socket)
    const forget = () => sockets.delete(socket)
    socket.on('close', forget)
    socket.on('error', forget)
    // A client frame is only ever a close: answer by ending the connection.
    socket.on('data', () => socket.end())
    send(socket, { type: 'build', id: current })
  })
  server.on('error', (error) => {
    console.warn(`[extension] self-reload is off: port ${port} is unavailable (${error.code})`)
  })
  server.listen(port, '127.0.0.1')
  setInterval(() => {
    for (const socket of sockets) send(socket, { type: 'ping' })
  }, KEEP_AWAKE_MS).unref()
  return () => {
    current = Date.now().toString(36)
    for (const socket of sockets) send(socket, { type: 'build', id: current })
    console.log(`[extension] reloading ${sockets.size} connected extension(s)`)
  }
}

/** Collapses the bundles and copies that one change sets off into a single announcement. */
function debounced(action, ms) {
  let timer = null
  return () => {
    clearTimeout(timer)
    timer = setTimeout(action, ms)
  }
}

const browsers = only ? [only] : Object.keys(TARGETS)
for (const browser of browsers) {
  if (!TARGETS[browser]) throw new Error(`Unknown browser "${browser}"; use firefox or chrome.`)
}
// Only this build's own output: the other kind of build may be loaded in a browser.
for (const browser of browsers) rmSync(TARGETS[browser].out, { recursive: true, force: true })
// An older single-browser build sat directly in dist/.
if (existsSync(join(root, 'dist', 'manifest.json'))) {
  for (const entry of readdirSync(join(root, 'dist'))) {
    if (!['firefox', 'chrome', 'dev'].includes(entry)) {
      rmSync(join(root, 'dist', entry), { recursive: true, force: true })
    }
  }
}

const announceBuild = watching ? debounced(serveReloads(reloadPort), 400) : null
const announcePlugin = {
  name: 'announce-build',
  setup(build) {
    let first = true
    build.onEnd((result) => {
      if (first) first = false
      else if (result.errors.length === 0) announceBuild()
    })
  }
}

const contexts = []
for (const browser of browsers) {
  const target = TARGETS[browser]
  copyStatic(browser, target.out)
  contexts.push(await bundler(browser, target, watching ? [announcePlugin] : []))
}

if (watching) {
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  let pending = null
  watch(root, { recursive: true }, (_event, file) => {
    if (!file || !existsSync(join(root, file))) return
    const rel = posix(file)
    if (rel !== 'manifest.json' && !shipped(join(root, file), classicScripts())) return
    clearTimeout(pending)
    pending = setTimeout(() => {
      for (const browser of browsers) copyStatic(browser, TARGETS[browser].out)
      console.log(`[extension] copied static files (${rel})`)
      announceBuild()
    }, 50)
  })
  console.log(
    '[extension] watching; load dist/dev/firefox/manifest.json in about:debugging, ' +
      'dist/dev/chrome in chrome://extensions (Developer mode → Load unpacked); ' +
      `both reload themselves after each rebuild (ws://127.0.0.1:${reloadPort})`
  )
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()))
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
}
