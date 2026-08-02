export default function EmptyState({ variant = 'library', onImport, importing, onAddTorrent }) {
  if (variant === 'no-results') {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔍</div>
        <h2>No books match</h2>
        <p>Try a different search term or genre filter.</p>
      </div>
    );
  }

  if (variant === 'downloads') {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📥</div>
        <h2>No downloads yet</h2>
        <p>Paste a magnet link above, or open a .torrent file to get started.</p>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-state-icon">📚</div>
      <h2>Your library is empty</h2>
      <p>
        Import your audiobooks, drag &amp; drop files or folders anywhere in this window, or
        add a torrent to start building your collection.
      </p>
      <div className="empty-state-actions">
        {onImport && (
          <button type="button" className="btn btn-primary" onClick={onImport} disabled={importing}>
            {importing ? 'Importing…' : 'Import books…'}
          </button>
        )}
        {onAddTorrent && (
          <button type="button" className="btn btn-ghost" onClick={onAddTorrent}>
            Add torrent
          </button>
        )}
      </div>
    </div>
  );
}
