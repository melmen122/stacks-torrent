import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';

const LibraryContext = createContext(null);

export function LibraryProvider({ children }) {
  const [books, setBooks] = useState([]);
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const result = await api.libraryList();
      setBooks(result?.books || []);
      setGenres(result?.genres || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
    const unsubscribe = api?.onLibraryChanged?.(() => refetch());
    return () => unsubscribe?.();
  }, [refetch]);

  const importBooks = useCallback(async () => {
    if (!api) return [];
    const added = await api.libraryImport();
    await refetch();
    return added;
  }, [refetch]);

  // Drag-and-drop import: paths already resolved via window.api.getPathForFile.
  // Optional-chained: safe to call even before the backend lands this channel.
  const importPaths = useCallback(async (paths) => {
    if (!api?.libraryImportPaths) return { added: [], skipped: paths || [] };
    const result = await api.libraryImportPaths(paths);
    await refetch();
    return result;
  }, [refetch]);

  const setGenre = useCallback(async (bookId, genreId) => {
    if (!api) return null;
    const updated = await api.librarySetGenre(bookId, genreId ?? null);
    await refetch();
    return updated;
  }, [refetch]);

  const removeBook = useCallback(async (bookId, opts) => {
    if (!api) return;
    await api.libraryRemoveBook(bookId, opts);
    await refetch();
  }, [refetch]);

  const createGenre = useCallback(async (name) => {
    if (!api) return null;
    const genre = await api.genresCreate(name);
    await refetch();
    return genre;
  }, [refetch]);

  const renameGenre = useCallback(async (id, name) => {
    if (!api) return null;
    const genre = await api.genresRename(id, name);
    await refetch();
    return genre;
  }, [refetch]);

  const deleteGenre = useCallback(async (id) => {
    if (!api) return;
    await api.genresDelete(id);
    await refetch();
  }, [refetch]);

  const value = {
    books,
    genres,
    loading,
    refetch,
    importBooks,
    importPaths,
    setGenre,
    removeBook,
    createGenre,
    renameGenre,
    deleteGenre,
  };

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used within a LibraryProvider');
  return ctx;
}
