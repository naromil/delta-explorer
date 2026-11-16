import { fileToImageAttachment } from '@delta/ui/lib/image-attachments'
import type {
  MaterialsRenderJob,
  MaterialsRenderResult,
  RenderedPage
} from '../../shared/materials-render'

/* Runs in the hidden render window: turns a PDF's pages, or an image file, into JPEGs. */

/** The long edge of a rendered page, the size vision models read without downscaling. */
const PAGE_LONG_EDGE_PX = 1568
const MAX_PAGE_SCALE = 3
const PAGE_JPEG_QUALITY = 0.8
const MAX_PAGE_TEXT_CHARS = 12_000

export function isRenderWindow(): boolean {
  return new URLSearchParams(window.location.search).get('role') === 'render'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode the page.'))
    reader.readAsDataURL(blob)
  })
}

async function renderImage(job: MaterialsRenderJob): Promise<RenderedPage[]> {
  const file = new File([job.data as BlobPart], 'image', { type: job.mediaType ?? '' })
  const { data } = await fileToImageAttachment(file)
  return [{ page: 1, text: '', image: data }]
}

async function renderPdf(
  job: MaterialsRenderJob
): Promise<{ pageCount: number; pages: RenderedPage[] }> {
  // Loaded on demand, as the library is large. The legacy build carries the polyfills for
  // JavaScript newer than the Chromium in this Electron; the default build fails to draw there.
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  ])
  GlobalWorkerOptions.workerSrc = workerUrl

  const loading = getDocument({ data: job.data, enableXfa: false })
  const document = await loading.promise
  try {
    const first = Math.min(Math.max(job.firstPage, 1), document.numPages)
    const last = Math.min(Math.max(job.lastPage, first), document.numPages)
    const pages: RenderedPage[] = []
    for (let number = first; number <= last; number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .trim()
        .slice(0, MAX_PAGE_TEXT_CHARS)
      const rendered: RenderedPage = { page: number, text }
      if (job.images) {
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(
          PAGE_LONG_EDGE_PX / Math.max(base.width, base.height),
          MAX_PAGE_SCALE
        )
        const viewport = page.getViewport({ scale })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        // `print` draws in one pass instead of waiting on animation frames a hidden window may not get.
        await page.render({ canvas, viewport, intent: 'print', background: '#ffffff' }).promise
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', PAGE_JPEG_QUALITY)
        )
        if (!blob) throw new Error(`Page ${number} could not be drawn.`)
        rendered.image = await blobToBase64(blob)
        canvas.width = 0
      }
      page.cleanup()
      pages.push(rendered)
    }
    return { pageCount: document.numPages, pages }
  } finally {
    void loading.destroy()
  }
}

async function run(job: MaterialsRenderJob): Promise<MaterialsRenderResult> {
  try {
    if (job.kind === 'image') {
      return { id: job.id, ok: true, pageCount: 1, pages: await renderImage(job) }
    }
    return { id: job.id, ok: true, ...(await renderPdf(job)) }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'The file could not be opened.'
    return { id: job.id, ok: false, error }
  }
}

export function startMaterialsRenderer(): void {
  window.api.onMaterialsRender((job) => {
    void run(job).then((result) => window.api.materialsRenderResult(result))
  })
  window.api.materialsRenderReady()
}
