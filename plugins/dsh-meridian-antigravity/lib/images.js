/**
 * Resolve durable image occurrences to request-ready bytes.
 *
 * Meridian inlines images: the block carries base64 bytes and the bridge writes
 * them into that turn's private workspace, replacing the block with an
 * instruction to view the generated path. The only alternative Meridian offers
 * is a public `https` URL that the *Meridian host* fetches, and loopback, LAN and
 * link-local addresses are refused there, so a URL can never address the harness
 * machine or a screenshot the harness just produced. Everything is inlined.
 *
 * The media type is one of `image/png`, `image/jpeg`, `image/gif`,
 * `image/webp`, which is exactly the harness attachment union, so the
 * `image/jpg` alias Meridian rejects on this route can never be produced.
 *
 * @module @local/dsh-meridian-antigravity/lib/images
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Read every non-offloaded image occurrence in one request.
 *
 * @param input - plugin context, request messages, cancellation, and count bound.
 * @returns a Map from durable attachment id to request-ready bytes and metadata.
 */
export async function readImageRefs({ ctx, messages, signal, maxImages }) {
  const refs = new Map()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (block.offloaded === true) continue
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  if (refs.size === 0) return new Map()
  if (refs.size > maxImages) {
    throw new LlmError(
      `meridian-antigravity: this request carries ${refs.size} images, over the configured limit of ${maxImages}`,
      'IMAGE_OFFLOAD_REQUIRED',
      { offloadImages: refs.size - maxImages },
    )
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new LlmError(
      'meridian-antigravity: this request carries images but no attachment service is mounted, so no bytes can be read',
      'UNSUPPORTED_CONTENT',
    )
  }
  const resolved = new Map()
  for (const [id, ref] of refs) {
    const stored = await attachments.readImage(ref, signal)
    resolved.set(id, {
      data: stored.data,
      mediaType: stored.ref?.mediaType ?? ref.mediaType,
      width: stored.ref?.width ?? ref.width,
      height: stored.ref?.height ?? ref.height,
    })
  }
  return resolved
}
