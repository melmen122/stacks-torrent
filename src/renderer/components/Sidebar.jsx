import { useState } from 'react';
import { useLibrary } from '../context/LibraryContext.jsx';
import { IconLibrary, IconDownload, IconGear, IconPlus } from './icons.jsx';
import GenreRow from './GenreRow.jsx';

export default function Sidebar({ view, onChangeView, selectedGenre, onSelectGenre }) {
  const { books, genres, createGenre, renameGenre, deleteGenre } = useLibrary();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const allCount = books.length;
  const uncategorizedCount = books.filter((b) => !b.genreId).length;

  const submitCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    setNewName('');
    setCreating(false);
    if (!name) return;
    const genre = await createGenre(name);
    if (genre) onSelectGenre(genre.id);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true">🎧</span>
        <span className="sidebar-brand-name">Stacks</span>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        <button
          type="button"
          className={`nav-item ${view === 'library' ? 'active' : ''}`}
          onClick={() => onChangeView('library')}
        >
          <IconLibrary /> Library
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'downloads' ? 'active' : ''}`}
          onClick={() => onChangeView('downloads')}
        >
          <IconDownload /> Downloads
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'settings' ? 'active' : ''}`}
          onClick={() => onChangeView('settings')}
        >
          <IconGear /> Settings
        </button>
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>Genres</span>
          <button
            type="button"
            className="icon-button-sm"
            title="New genre"
            aria-label="Create new genre"
            onClick={() => setCreating((c) => !c)}
          >
            <IconPlus />
          </button>
        </div>

        {creating && (
          <form className="genre-create-form" onSubmit={submitCreate}>
            <input
              autoFocus
              aria-label="New genre name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Genre name"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
              onBlur={() => { if (!newName.trim()) setCreating(false); }}
            />
          </form>
        )}

        <ul className="genre-list">
          <li>
            <button
              type="button"
              className={`genre-row ${selectedGenre === 'all' ? 'active' : ''}`}
              onClick={() => onSelectGenre('all')}
            >
              <span className="genre-row-name">All Books</span>
              <span className="genre-count">{allCount}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`genre-row ${selectedGenre === 'uncategorized' ? 'active' : ''}`}
              onClick={() => onSelectGenre('uncategorized')}
            >
              <span className="genre-row-name">Uncategorized</span>
              <span className="genre-count">{uncategorizedCount}</span>
            </button>
          </li>
          {genres.map((g) => (
            <GenreRow
              key={g.id}
              genre={g}
              count={books.filter((b) => b.genreId === g.id).length}
              active={selectedGenre === g.id}
              onSelect={() => onSelectGenre(g.id)}
              onRename={(name) => renameGenre(g.id, name)}
              onDelete={() => {
                deleteGenre(g.id);
                if (selectedGenre === g.id) onSelectGenre('all');
              }}
            />
          ))}
        </ul>
      </div>
    </aside>
  );
}
