/** One image for a model: a supported media type plus raw base64 (no `data:` prefix). */
export interface ImageInput {
  mediaType: string
  data: string
}

/** One message in the provider-agnostic request shape used by every backend. */
export interface ProviderMessage {
  role: string
  content: string
  /** User messages only. */
  images?: ImageInput[]
}
