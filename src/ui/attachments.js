/* Image attachments, ported from Delta Explorer's lib/image-attachments.ts
 * and shared/attachments.ts. Images are decoded, scaled to a 1568px long edge
 * and re-encoded as JPEG, which keeps records small and strips metadata such as
 * EXIF GPS coordinates before anything leaves the browser. */

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_IMAGE_EDGE = 1568;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const OUTPUT_TYPE = 'image/jpeg';
const OUTPUT_QUALITY = 0.85;
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function scaledSize(width, height) {
  const longest = Math.max(width, height);
  if (longest <= MAX_IMAGE_EDGE) return { width, height };
  const ratio = MAX_IMAGE_EDGE / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function readBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

export async function fileToImageAttachment(file) {
  if (!SUPPORTED.has(file.type)) throw new Error(`${file.name || 'That file'} is not a PNG, JPEG, WebP or GIF image.`);
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name} is too large (30 MB limit).`);
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the image.');
    // JPEG has no alpha; transparent screenshots would otherwise turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: OUTPUT_TYPE, quality: OUTPUT_QUALITY });
    return { name: (file.name || 'image').slice(0, 255), mediaType: OUTPUT_TYPE, data: await readBase64(blob) };
  } finally {
    bitmap.close();
  }
}

export function attachmentSrc(attachment) {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}
