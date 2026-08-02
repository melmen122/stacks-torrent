// Chapter list derivation + "which chapter is playing now" logic, shared by
// PlayerContext (computes the active chapter) and ChapterMenu (renders it).

/** "01 - The Beginning.mp3" -> "The Beginning"; falls back to the raw name. */
function cleanFileName(path) {
  const base = (path || '').split(/[\\/]/).pop() || '';
  const withoutExt = base.replace(/\.[^./\\]+$/, '');
  const stripped = withoutExt
    .replace(/^\s*\d+[\s._-]*/, '') // leading track number ("01", "03.", "12 -")
    .replace(/^[-_\s]+/, '') // any remaining leading separators
    .replace(/[_]+/g, ' ')
    .trim();
  return stripped || withoutExt.trim() || base;
}

/**
 * Returns an ordered chapter list for a book:
 * - `book.chapters` when present (embedded chapter markers from metadata), or
 * - one derived chapter per file otherwise (title = cleaned filename).
 * Each entry: { title, fileIndex, startSec }.
 */
export function getChapters(book) {
  if (!book) return [];

  if (Array.isArray(book.chapters) && book.chapters.length > 0) {
    return book.chapters.map((c, i) => ({
      title: c.title || `Chapter ${i + 1}`,
      fileIndex: c.fileIndex ?? 0,
      startSec: c.startSec || 0,
    }));
  }

  return (book.files || []).map((file, i) => ({
    title: cleanFileName(file) || `Chapter ${i + 1}`,
    fileIndex: i,
    startSec: 0,
  }));
}

/**
 * Index of the currently-playing chapter: the last chapter (in list order)
 * whose fileIndex/startSec is at or before the current playback position.
 * Works for both embedded chapters (multiple per file, startSec varies) and
 * derived per-file chapters (startSec is always 0, so this just matches the
 * chapter for the current file).
 */
export function currentChapterIndex(chapters, fileIndex, currentTime) {
  let active = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    if (c.fileIndex < fileIndex) {
      active = i;
    } else if (c.fileIndex === fileIndex && c.startSec <= currentTime) {
      active = i;
    }
  }
  return active;
}
