import { useRef, useState } from 'react';
import { useLibrary } from '../context/LibraryContext.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { formatDuration } from '../utils/format.js';
import { mediaUrl } from '../utils/media.js';
import { gradientFor, initialsFor } from '../utils/color.js';
import { IconPlay, IconDots, IconCheck, IconClose } from './icons.jsx';
import IconMenu from './IconMenu.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

export default function BookCard({ book, genres }) {
  const { setGenre, createGenre, removeBook } = useLibrary();
  const player = usePlayer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const menuButtonRef = useRef(null);

  const isCurrent = player.book?.id === book.id;
  const genre = genres.find((g) => g.id === book.genreId);

  const handlePlay = () => {
    if (isCurrent) player.togglePlay();
    else player.playBook(book);
  };

  const acceptSuggestion = async () => {
    const name = book.suggestedGenre;
    if (!name) return;
    const existing = genres.find((g) => g.name.toLowerCase() === name.toLowerCase());
    const genreId = existing ? existing.id : (await createGenre(name))?.id;
    if (genreId) await setGenre(book.id, genreId);
  };

  const rejectSuggestion = () => setGenre(book.id, book.genreId ?? null);

  const menuItems = [
    { label: 'Uncategorized', active: !book.genreId, onClick: () => setGenre(book.id, null) },
    ...genres.map((g) => ({
      label: g.name,
      active: book.genreId === g.id,
      onClick: () => setGenre(book.id, g.id),
    })),
    { separator: true },
    { label: 'Remove from library', danger: true, onClick: () => setConfirmingRemove(true) },
  ];

  return (
    <div className="book-card">
      <div className="book-cover">
        {book.coverPath ? (
          <img src={mediaUrl(book.coverPath)} alt="" className="book-cover-img" />
        ) : (
          <div
            className="book-cover-placeholder"
            style={{ background: gradientFor(`${book.title || ''}${book.author || ''}`) }}
          >
            <span>{initialsFor(book.title)}</span>
          </div>
        )}

        <button
          type="button"
          className="book-play-overlay"
          onClick={handlePlay}
          aria-label={isCurrent && player.isPlaying ? 'Pause' : 'Play'}
        >
          <IconPlay playing={isCurrent && player.isPlaying} />
        </button>

        {book.suggestedGenre && (
          <div className="suggestion-pill">
            <span title={`Suggested: ${book.suggestedGenre}`}>Suggested: {book.suggestedGenre}</span>
            <button type="button" onClick={acceptSuggestion} aria-label="Accept genre suggestion">
              <IconCheck />
            </button>
            <button type="button" onClick={rejectSuggestion} aria-label="Dismiss genre suggestion">
              <IconClose />
            </button>
          </div>
        )}
      </div>

      <div className="book-info">
        <div className="book-info-top">
          <div className="book-info-text">
            <h3 className="book-title" title={book.title}>{book.title}</h3>
            <p className="book-author" title={book.author}>{book.author}</p>
          </div>
          <div className="book-card-menu">
            <button
              type="button"
              ref={menuButtonRef}
              className="icon-button-sm"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Book options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <IconDots />
            </button>
            {menuOpen && (
              <IconMenu items={menuItems} anchorRef={menuButtonRef} onClose={() => setMenuOpen(false)} />
            )}
          </div>
        </div>

        <div className="book-info-bottom">
          <span className="book-duration">{formatDuration(book.durationSec)}</span>
          <span className={`genre-chip ${!genre ? 'genre-chip-muted' : ''}`}>
            {genre ? genre.name : 'Uncategorized'}
          </span>
        </div>
      </div>

      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove "${book.title}"?`}
          message="This removes the book from your library."
          checkboxLabel="Also delete files from disk"
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={(deleteFiles) => {
            setConfirmingRemove(false);
            removeBook(book.id, { deleteFiles });
          }}
        />
      )}
    </div>
  );
}
