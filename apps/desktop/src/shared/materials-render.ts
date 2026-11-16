/* The job the main process hands the hidden render window, and what comes back. */

export interface MaterialsRenderJob {
  id: number
  kind: 'pdf' | 'image'
  /** For an image: its media type, which the decoder needs. */
  mediaType?: string
  data: Uint8Array
  /** 1-based and inclusive; ignored for an image. */
  firstPage: number
  lastPage: number
  /** False for a model that reads no images: only the text layer is extracted. */
  images: boolean
}

export interface RenderedPage {
  page: number
  /** The page's text layer; empty for a scan or an image. */
  text: string
  /** A JPEG as base64, when images were asked for. */
  image?: string
}

export type MaterialsRenderResult = { id: number } & (
  { ok: true; pageCount: number; pages: RenderedPage[] } | { ok: false; error: string }
)
