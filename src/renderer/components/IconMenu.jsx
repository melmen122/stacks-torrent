import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck } from './icons.jsx';

const EDGE_MARGIN = 8; // minimum gap kept from the viewport edges
const ANCHOR_GAP = 4; // gap between the trigger and the menu

/**
 * Small floating dropdown menu (genre assignment, book/genre options).
 *
 * Portaled to `document.body` and positioned with `position: fixed` against
 * the trigger's bounding rect, rather than `position: absolute` inside the
 * trigger's own DOM subtree — several ancestors (`.book-card`, `.app-main`,
 * `.app-shell`) use `overflow: hidden`/`auto` for rounded corners and
 * scroll containment, which silently clipped the menu whenever it grew
 * past the card. Portaling escapes all of that.
 *
 * items: [{ label, onClick, danger?, active?, disabled?, hint?, separator? }]
 * `hint` (optional) renders as a native title tooltip, useful for
 * explaining *why* a disabled item is disabled (e.g. "Add a key in Settings").
 * anchorRef: ref to the trigger element the menu should hang off of.
 */
export default function IconMenu({ items, onClose, anchorRef, align = 'right' }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    // Treat the player bar's top edge as the effective bottom of the
    // viewport when it's present, so the menu prefers opening upward
    // rather than sliding in behind/on top of the persistent player
    // controls.
    const playerBar = document.querySelector('.player-bar');
    const bottomLimit = (playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight) - EDGE_MARGIN;

    let top = anchorRect.bottom + ANCHOR_GAP;
    if (top + menuRect.height > bottomLimit) {
      // Not enough room below — open upward instead.
      top = anchorRect.top - ANCHOR_GAP - menuRect.height;
    }
    top = Math.max(EDGE_MARGIN, Math.min(top, window.innerHeight - menuRect.height - EDGE_MARGIN));

    let left = align === 'right' ? anchorRect.right - menuRect.width : anchorRect.left;
    left = Math.max(EDGE_MARGIN, Math.min(left, window.innerWidth - menuRect.width - EDGE_MARGIN));

    setPosition({ top, left });
  }, [anchorRef, align, items]);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return; // let the trigger's own onClick toggle it
      onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    // Scroll/resize can move the anchor out from under a fixed-position
    // menu; closing is simpler and safer than continuously re-tracking.
    // `capture: true` is needed to observe scrolling inside any scrollable
    // ancestor (scroll events don't bubble). But the menu itself scrolls
    // (long genre lists, max-height + overflow-y: auto) — a scroll that
    // originates inside the menu must NOT close it, or items past the
    // fold become unreachable the moment you try to scroll to them.
    const handleReposition = (e) => {
      // `resize` events target `window`, which isn't a Node — Node.contains()
      // throws on a non-Node argument, so guard with `instanceof Node` first.
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
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

  return createPortal(
    <div
      className="icon-menu"
      ref={menuRef}
      role="menu"
      style={{
        top: position ? `${position.top}px` : '-9999px',
        left: position ? `${position.left}px` : '-9999px',
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {items.map((item, i) => (
        item.separator ? (
          <div key={`sep-${i}`} className="icon-menu-separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            title={item.hint}
            disabled={item.disabled}
            className={`icon-menu-item ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}`}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            <span className="icon-menu-check">{item.active ? <IconCheck /> : null}</span>
            {item.label}
          </button>
        )
      ))}
    </div>,
    document.body,
  );
}
