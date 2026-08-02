import { useMemo, useState } from 'react';
import { useLibrary } from '../context/LibraryContext.jsx';
import Toolbar from './Toolbar.jsx';
import BookCard from './BookCard.jsx';
import EmptyState from './EmptyState.jsx';

export default function LibraryView({ selectedGenre, onNavigateDownloads }) {
  const { books, genres, loading, importBooks } = useLibrary();
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [importingBooks, setImportingBooks] = useState(false);

  // Guard against double-clicks / re-clicking while a (potentially slow,
  // large-folder) import is still running — a second concurrent import
  // would create duplicate books.
  const handleImport = async () => {
    if (importingBooks) return;
    setImportingBooks(true);
    try {
      await importBooks();
    } finally {
      setImportingBooks(false);
    }
  };

  const genreTitle = useMemo(() => {
    if (selectedGenre === 'all') return 'All Books';
    if (selectedGenre === 'uncategorized') return 'Uncategorized';
    return genres.find((g) => g.id === selectedGenre)?.name || 'Genre';
  }, [selectedGenre, genres]);

  const filteredBooks = useMemo(() => {
    let list = books;
    if (selectedGenre === 'uncategorized') list = list.filter((b) => !b.genreId);
    else if (selectedGenre !== 'all') list = list.filter((b) => b.genreId === selectedGenre);

    const q = searchTerm.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) => b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q),
      );
    }

    const sorted = [...list];
    if (sortBy === 'title') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else if (sortBy === 'author') sorted.sort((a, b) => (a.author || '').localeCompare(b.author || ''));
    else sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return sorted;
  }, [books, selectedGenre, searchTerm, sortBy]);

  return (
    <div className="library-view">
      <Toolbar
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        sortBy={sortBy}
        onSortChange={setSortBy}
        onImport={handleImport}
        importing={importingBooks}
        onAddTorrent={onNavigateDownloads}
      />

      <h1 className="view-title">{genreTitle}</h1>

      {loading ? (
        <div className="loading-state">Loading your library…</div>
      ) : books.length === 0 ? (
        <EmptyState
          variant="library"
          onImport={handleImport}
          importing={importingBooks}
          onAddTorrent={onNavigateDownloads}
        />
      ) : filteredBooks.length === 0 ? (
        <EmptyState variant="no-results" />
      ) : (
        <div className="book-grid">
          {filteredBooks.map((book) => (
            <BookCard key={book.id} book={book} genres={genres} />
          ))}
        </div>
      )}
    </div>
  );
}
