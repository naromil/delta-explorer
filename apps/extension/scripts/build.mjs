/**
 * Builds the extension into `dist/`, which is what Firefox loads.
 *
 * The extension pages and the background are ES modules that import `@delta/core`, which a
 * browser cannot resolve, so each entry is bundled by esbuild. Everything else (manifest,
 * HTML, CSS, icons, vendored KaTeX and the classic scripts the manifest and pages load
 * directly, such as the content scripts) is copied as it is.
 *
 *   node scripts/build.mjs          one build
 *   node scripts/build.mjs --watch  rebuild on every change
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')
const watching = process.argv.includes('--watch')

/** Module entry points: everything they import is bundled into them. */
const ENTRIES = ['background.js', 'popup/popup.js', 'dashboard/js/app.js', 'canvas/canvas.js']

/** Never shipped: tooling, docs and build output. */
const SKIPPED = new Set(['dist', 'node_modules', 'scripts', 'docs', 'package.json', '.gitignore'])

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
  if (SKIPPED.has(top) || rel.endsWith('.md')) return false
  return !rel.endsWith('.js') || classic.has(rel)
}

function copyStatic() {
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
}

rmSync(out, { recursive: true, force: true })
copyStatic()

const ctx = await context({
  absWorkingDir: root,
  entryPoints: ENTRIES.map((entry) => ({ in: entry, out: entry.replace(/\.js$/, '') })),
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'firefox140',
  // Readable output: add-on review reads what ships.
  minify: false,
  sourcemap: watching ? 'linked' : false,
  legalComments: 'inline',
  logLevel: 'info'
})

if (watching) {
  await ctx.watch()
  let pending = null
  watch(root, { recursive: true }, (_event, file) => {
    if (!file || !existsSync(join(root, file)) || !shipped(join(root, file), classicScripts())) {
      return
    }
    clearTimeout(pending)
    pending = setTimeout(() => {
      copyStatic()
      console.log(`[extension] copied static files (${posix(file)})`)
    }, 50)
  })
  console.log('[extension] watching; load dist/manifest.json in about:debugging')
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
