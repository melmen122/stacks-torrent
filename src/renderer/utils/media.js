/**
 * Build a `media://` URL for an absolute filesystem path, matching the
 * custom protocol registered by the main process (see docs/PLAN.md).
 */
export function mediaUrl(absPath) {
  if (!absPath) return '';
  return `media://file/${encodeURIComponent(absPath)}`;
}
