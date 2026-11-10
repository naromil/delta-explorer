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
 *   node scripts/build.mjs --watch            both browsers, rebuilt on every change
 *   node scripts/build.mjs --browser=chrome   one browser (with or without --watch)
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
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watching = process.argv.includes('--watch')
const only = process.argv.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length)

/** Each browser's output directory and esbuild target. */
const TARGETS = {
  firefox: { out: join(root, 'dist', 'firefox'), esbuild: 'firefox140' },
  chrome: { out: join(root, 'dist', 'chrome'), esbuild: 'chrome120' }
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

function writeManifest(browser, out) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
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

async function bundler(browser, { out, esbuild }) {
  return context({
    absWorkingDir: root,
    entryPoints: [...ENTRIES, ...CSS_ENTRIES].map((entry) => ({
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
    define: { 'process.env.NODE_ENV': JSON.stringify(watching ? 'development' : 'production') },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
    // Readable output: add-on review reads what ships.
    minify: false,
    sourcemap: watching ? 'linked' : false,
    legalComments: 'inline',
    logLevel: 'info'
  })
}

const browsers = only ? [only] : Object.keys(TARGETS)
for (const browser of browsers) {
  if (!TARGETS[browser]) throw new Error(`Unknown browser "${browser}"; use firefox or chrome.`)
}
// An older single-browser build sat directly in dist/.
rmSync(join(root, 'dist'), { recursive: true, force: true })

const contexts = []
for (const browser of browsers) {
  const target = TARGETS[browser]
  copyStatic(browser, target.out)
  contexts.push(await bundler(browser, target))
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
    }, 50)
  })
  console.log(
    '[extension] watching; load dist/firefox/manifest.json in about:debugging, ' +
      'dist/chrome in chrome://extensions (Developer mode → Load unpacked)'
  )
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()))
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
}
