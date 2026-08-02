import { useRef, useState } from 'react';
import { IconDots } from './icons.jsx';
import IconMenu from './IconMenu.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

export default function GenreRow({ genre, count, active, onSelect, onRename, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(genre.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuButtonRef = useRef(null);

  const submitRename = (e) => {
    e.preventDefault();
    const name = draft.trim();
    if (name && name !== genre.name) onRename(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <li>
        <form className="genre-rename-form" onSubmit={submitRename}>
          <input
            autoFocus
            aria-label="Rename genre"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setEditing(false); setDraft(genre.name); }
            }}
            onBlur={submitRename}
          />
        </form>
      </li>
    );
  }

  return (
    <li className="genre-li">
      <button className={`genre-row ${active ? 'active' : ''}`} onClick={onSelect}>
        <span className="genre-row-name">{genre.name}</span>
        <span className="genre-count">{count}</span>
      </button>

      <div className="genre-row-menu">
        <button
          type="button"
          ref={menuButtonRef}
          className="icon-button-sm genre-menu-trigger"
          title={`${genre.name} options`}
          aria-label={`${genre.name} options`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
        >
          <IconDots />
        </button>
        {menuOpen && (
          <IconMenu
            anchorRef={menuButtonRef}
            onClose={() => setMenuOpen(false)}
            items={[
              { label: 'Rename', onClick: () => { setEditing(true); setDraft(genre.name); } },
              { label: 'Delete', danger: true, onClick: () => setConfirmingDelete(true) },
            ]}
          />
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete "${genre.name}"?`}
          message="Books in this genre will become Uncategorized. This can't be undone."
          confirmLabel="Delete genre"
          danger
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); onDelete(); }}
        />
      )}
    </li>
  );
}
