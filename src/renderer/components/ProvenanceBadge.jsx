import { useRef, useState } from 'react';
import SafetyDetails from './SafetyDetails.jsx';

/**
 * Layer-1 (pre-download manifest check) positive signal on a BookCard —
 * NOT to be confused with `ScanBadge` (layer-2, VirusTotal, a post-download
 * hash lookup). Reflects `book.source`, persisted at import time:
 *
 *  - `{ type: 'torrent', safety: {...} }` — this book's torrent had its
 *    file manifest checked *before* any content downloaded; only audio
 *    was ever fetched. For nearly every audiobook this is the ONLY
 *    meaningful safety statement the app can make (VirusTotal returns
 *    'unknown' for almost all of them — see ScanBadge), so it gets real
 *    visual weight here, not a faint afterthought.
 *  - `{ type: 'import' }` — user-supplied files, never classified. No
 *    safety claim is made; BookCard doesn't even render this component
 *    for that case (see below) rather than implying verification that
 *    never happened.
 *  - `null`/absent — legacy book (added before this field existed) or no
 *    report available. Unknown provenance, NOT unsafe — also not
 *    rendered.
 *
 * `safety.skippedCount` is the TRUE, uncapped count of skipped files;
 * `safety.skipped` is capped to the first 50 (same shape SafetyDetails
 * already renders for TorrentRow's SafetyBadge, so it's reused as-is here
 * — see SafetyDetails' own truncation note for how the cap is surfaced).
 *
 * The headline count is deliberately RISKY-ONLY (excludes the 'companion'
 * category — cover art, .nfo, .cue, .m3u, .txt, etc.): those are benign
 * and skipped as a matter of course, so counting them toward "N risky
 * files skipped" would over-warn on completely ordinary torrents (e.g. 30
 * mp3s + 1 archive + 6 cover/companion files is NOT "7 risky files"). That
 * exact filtering is only derivable when `skipped` isn't truncated — see
 * the three-way branch below.
 */
export default function ProvenanceBadge({ bookTitle, source }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);

  const safety = source?.type === 'torrent' ? source.safety : null;
  if (!safety || !['clean', 'caution', 'danger'].includes(safety.verdict)) return null;
  // Defense-in-depth: nothing today can persist a torrent source without
  // audio (a no-audio torrent never becomes a book), so this is
  // unreachable in practice — but never let a future change make this
  // component claim "audio-only" for a book it can't vouch for.
  if (safety.hasAudio === false) return null;

  const skipped = safety.skipped;
  const skippedCount = safety.skippedCount || 0;
  const hasSkippedList = Array.isArray(skipped) && skipped.length > 0;
  const isTruncated = Array.isArray(skipped) && skippedCount > skipped.length;

  // Exact risky (non-companion) count — only computable from the FULL
  // list. `null` means "truncated, can't derive an honest risky-only
  // number" (never invent one by, say, filtering just the visible 50).
  const riskyCount = !isTruncated && Array.isArray(skipped)
    ? skipped.filter((file) => file?.category !== 'companion').length
    : null;

  let headline;
  let badgeCount = null;

  if (safety.verdict === 'clean' || riskyCount === 0) {
    // Nothing risky (companions don't count, and a `clean` verdict never
    // has any non-companion skip by construction) — confident, simple claim.
    headline = 'Audio-only download — no executables';
  } else if (riskyCount != null) {
    // Non-truncated: exact risky-only count.
    headline = `Audio only — ${riskyCount} risky file${riskyCount === 1 ? '' : 's'} skipped`;
    badgeCount = riskyCount;
  } else {
    // Truncated: an exact risky-only count isn't derivable without
    // under-counting, so say something true instead — total skipped,
    // worded so it never calls them all "risky".
    headline = `Audio only — ${skippedCount} file${skippedCount === 1 ? '' : 's'} skipped`;
    badgeCount = skippedCount;
  }

  if (!hasSkippedList) {
    // Nothing to show details for (or the backend didn't send a list at
    // all) — plain, non-interactive statement.
    return (
      <div className="provenance-badge">
        <span aria-hidden="true">✓</span>
        {headline}
      </div>
    );
  }

  // Companions (or risky files) exist to show — clickable, details
  // reachable via the same popover TorrentRow's SafetyBadge uses.
  return (
    <div className="provenance-badge-trigger">
      <button
        type="button"
        ref={buttonRef}
        className="provenance-badge provenance-badge-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="See exactly what was found in the torrent but never downloaded"
      >
        <span aria-hidden="true">✓</span>
        {headline}
        {badgeCount != null && <span className="provenance-badge-count">{badgeCount}</span>}
      </button>
      {open && (
        <SafetyDetails
          torrentName={bookTitle}
          safety={safety}
          report={safety}
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
