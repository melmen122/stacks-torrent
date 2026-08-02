import { useEffect, useRef } from 'react';
import { formatClock } from '../utils/format.js';

/**
 * Floating chapter list, anchored above its (positioned) parent — the
 * player bar sits at the bottom of the screen, so this opens upward.
 * Closes on outside click or Escape, same pattern as IconMenu.
 */
export default function ChapterMenu({ chapters, activeIndex, onSelect, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div className="chapter-menu" ref={ref} role="menu" aria-label="Chapters">
      <div className="chapter-menu-header">Chapters</div>
      {chapters.length === 0 ? (
        <p className="chapter-menu-empty">No chapters available.</p>
      ) : (
        <ul className="chapter-menu-list">
          {chapters.map((c, i) => (
            <li key={`${c.fileIndex}-${c.startSec}-${i}`}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={i === activeIndex}
                className={`chapter-menu-item ${i === activeIndex ? 'active' : ''}`}
                onClick={() => { onSelect(c); onClose(); }}
              >
                <span className="chapter-menu-item-title">{c.title}</span>
                <span className="chapter-menu-item-time">{formatClock(c.startSec)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
