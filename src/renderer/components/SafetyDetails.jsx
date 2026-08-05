import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE_MARGIN = 8;
const ANCHOR_GAP = 4;

const CATEGORY_LABEL = {
  companion: 'Companion file',
  archive: 'Archive',
  executable: 'Executable',
  disguised: 'Disguised executable',
  other: 'Unrecognized',
};

/**
 * Read-only popover listing the files a torrent's safety check skipped.
 * Portaled to `document.body` with viewport-relative `position: fixed`,
 * same rationale/pattern as IconMenu.jsx (torrent rows live inside
 * `.app-main`, which clips overflow) — deliberately a standalone
 * implementation rather than reusing IconMenu, since that component is
 * shaped around clickable action items, not a read-only detail list, and
 * this avoids touching an already-hardened component for an unrelated
 * feature.
 */
export default function SafetyDetails({ torrentName, safety, report, anchorRef, onClose }) {
  const panelRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    // Same player-bar-aware floor as IconMenu, so the popover doesn't open
    // underneath the persistent player controls.
    const playerBar = document.querySelector('.player-bar');
    const bottomLimit = (playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight) - EDGE_MARGIN;

    let top = anchorRect.bottom + ANCHOR_GAP;
    if (top + panelRect.height > bottomLimit) {
      top = anchorRect.top - ANCHOR_GAP - panelRect.height;
    }
    top = Math.max(EDGE_MARGIN, Math.min(top, window.innerHeight - panelRect.height - EDGE_MARGIN));

    let left = Math.max(EDGE_MARGIN, Math.min(anchorRect.left, window.innerWidth - panelRect.width - EDGE_MARGIN));

    setPosition({ top, left });
  }, [anchorRef, report]);

  useEffect(() => {
    const handleClick = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const handleReposition = (e) => {
      // resize targets `window`, which isn't a Node — guard before .contains().
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      onClose();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [onClose, anchorRef]);

  const skipped = report?.skipped;
  const count = safety?.skippedCount ?? skipped?.length ?? 0;

  return createPortal(
    <div
      className="safety-details"
      ref={panelRef}
      role="dialog"
      aria-label={`Skipped files in ${torrentName}`}
      style={{
        top: position ? `${position.top}px` : '-9999px',
        left: position ? `${position.left}px` : '-9999px',
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="safety-details-header">
        {count} file{count === 1 ? '' : 's'} skipped
      </div>

      {!skipped ? (
        <p className="safety-details-empty">
          Details aren&rsquo;t available for this session — re-add the torrent to see specifics.
        </p>
      ) : skipped.length === 0 ? (
        <p className="safety-details-empty">No skipped files.</p>
      ) : (
        <>
          <ul className="safety-details-list">
            {skipped.map((file, i) => (
              <li key={`${file.name}-${i}`} className="safety-details-item">
                <div className="safety-details-item-top">
                  <span className="safety-details-item-name" title={file.name}>{file.name}</span>
                  <span className={`safety-details-category safety-details-category-${file.category}`}>
                    {CATEGORY_LABEL[file.category] || file.category || 'Unrecognized'}
                  </span>
                </div>
                {file.reason && <p className="safety-details-reason">{file.reason}</p>}
              </li>
            ))}
          </ul>
          {/* `skipped` is capped (currently to the first 50); `count` above
              is the true, uncapped total — make the gap explicit rather
              than silently showing a partial list next to a bigger number. */}
          {count > skipped.length && (
            <p className="safety-details-truncated">
              Showing the first {skipped.length} of {count}.
            </p>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
