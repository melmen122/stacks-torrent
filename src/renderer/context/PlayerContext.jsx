import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { mediaUrl } from '../utils/media.js';
import { getChapters, currentChapterIndex } from '../utils/chapters.js';
import { useLibrary } from './LibraryContext.jsx';

const PlayerContext = createContext(null);

const VOLUME_KEY = 'stacks:player:volume';

/** Clamp to a finite [0,1] value, falling back to 1 for anything corrupt. */
function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  const pendingSeekRef = useRef(0);

  // In-session cache of the latest saved position per book (bookId -> { fileIndex, seconds }).
  // LibraryContext's `books` only reflects positions as of the last library:list fetch —
  // playerSavePosition doesn't trigger a library:changed broadcast, so without this cache
  // re-playing a book in the same session would seek back to a stale position and the next
  // periodic save would clobber the real on-disk position with it. This cache always wins
  // over `book.position` while the app is open.
  const positionsRef = useRef(new Map());

  const { books } = useLibrary();

  const [book, setBook] = useState(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(() => {
    if (typeof window === 'undefined') return 1;
    return clampVolume(window.localStorage.getItem(VOLUME_KEY));
  });

  const setVolume = useCallback((v) => {
    const clamped = clampVolume(v);
    setVolumeState(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
    if (typeof window !== 'undefined') window.localStorage.setItem(VOLUME_KEY, String(clamped));
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    // Only run once on mount to apply the persisted volume to the element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single choke point for persisting a position: updates the in-session
  // cache immediately and best-effort persists it via IPC (swallowing
  // rejections, e.g. if the book was removed mid-playback).
  const persistPosition = useCallback((bookId, targetFileIndex, seconds) => {
    if (!bookId) return;
    positionsRef.current.set(bookId, { fileIndex: targetFileIndex, seconds });
    api?.playerSavePosition?.(bookId, targetFileIndex, seconds)?.catch?.(() => {});
  }, []);

  const savePosition = useCallback((overrideSeconds) => {
    if (!book) return;
    const seconds = overrideSeconds != null ? overrideSeconds : Math.floor(audioRef.current?.currentTime || 0);
    persistPosition(book.id, fileIndex, seconds);
  }, [book, fileIndex, persistPosition]);

  // Periodically persist playback position while audio is playing.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const id = setInterval(() => savePosition(), 5000);
    return () => clearInterval(id);
  }, [isPlaying, savePosition]);

  // If the currently-playing book disappears from the library (removed,
  // or genre/library mutation drops it from the fetched list), stop
  // playback instead of continuing to hit IPC with a book id that no
  // longer exists.
  useEffect(() => {
    if (!book) return;
    const stillExists = books.some((b) => b.id === book.id);
    if (!stillExists) {
      audioRef.current?.pause();
      setIsPlaying(false);
      setBook(null);
    }
  }, [books, book]);

  const playBook = useCallback((targetBook) => {
    const cached = positionsRef.current.get(targetBook?.id);
    const startIndex = cached?.fileIndex ?? targetBook?.position?.fileIndex ?? 0;
    const startSeconds = cached?.seconds ?? targetBook?.position?.seconds ?? 0;
    pendingSeekRef.current = startSeconds;
    setBook(targetBook);
    setFileIndex(startIndex);
    setIsPlaying(true);
  }, []);

  // Load the correct file into the <audio> element whenever the current
  // book or file index changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !book) return undefined;
    const path = book.files?.[fileIndex];
    if (!path) return undefined;

    audio.src = mediaUrl(path);
    audio.load();

    const onLoadedMetadata = () => {
      const seek = pendingSeekRef.current;
      if (seek) {
        audio.currentTime = seek;
        setCurrentTime(seek);
        pendingSeekRef.current = 0;
      }
      setDuration(audio.duration || 0);
      if (isPlaying) audio.play().catch(() => {});
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    return () => audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    // isPlaying intentionally omitted: this effect should only re-run when
    // switching book/file, not on every play/pause toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id, fileIndex]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !book) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      savePosition();
    } else {
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [book, isPlaying, savePosition]);

  const seekTo = useCallback((seconds) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const skip = useCallback((delta) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = audio.duration || Infinity;
    const next = Math.min(Math.max(audio.currentTime + delta, 0), max);
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  const goToFile = useCallback((index) => {
    if (!book || index < 0 || index >= (book.files?.length || 0)) return;
    // Persist the *target* file index (not the one we're leaving) at 0
    // seconds, so resuming later starts the new file from its beginning.
    persistPosition(book.id, index, 0);
    pendingSeekRef.current = 0;
    setFileIndex(index);
  }, [book, persistPosition]);

  const nextFile = useCallback(() => goToFile(fileIndex + 1), [fileIndex, goToFile]);
  const prevFile = useCallback(() => goToFile(fileIndex - 1), [fileIndex, goToFile]);

  // Chapters: from book.chapters (embedded metadata) when present, else one
  // derived chapter per file. See utils/chapters.js.
  const chapters = useMemo(() => getChapters(book), [book]);
  const activeChapterIndex = useMemo(
    () => currentChapterIndex(chapters, fileIndex, currentTime),
    [chapters, fileIndex, currentTime],
  );

  const jumpToChapter = useCallback((chapter) => {
    if (!book || !chapter) return;
    if (chapter.fileIndex === fileIndex) {
      // Same file: no reload needed, just seek (position-saving unchanged —
      // goes through the same persistPosition choke point as everything else).
      seekTo(chapter.startSec);
      persistPosition(book.id, fileIndex, chapter.startSec);
    } else {
      pendingSeekRef.current = chapter.startSec;
      persistPosition(book.id, chapter.fileIndex, chapter.startSec);
      setFileIndex(chapter.fileIndex);
    }
  }, [book, fileIndex, seekTo, persistPosition]);

  const handleEnded = useCallback(() => {
    if (book && fileIndex < (book.files?.length || 0) - 1) {
      const next = fileIndex + 1;
      persistPosition(book.id, next, 0);
      pendingSeekRef.current = 0;
      setFileIndex(next);
      setIsPlaying(true);
    } else {
      // Finished the last file: don't persist {lastIndex, ~duration} (that
      // would resume right at the end) — reset to the beginning instead.
      setIsPlaying(false);
      if (book) persistPosition(book.id, 0, 0);
    }
  }, [book, fileIndex, persistPosition]);

  const handleTimeUpdate = useCallback(() => {
    setCurrentTime(audioRef.current?.currentTime || 0);
  }, []);

  const handleDurationChange = useCallback(() => {
    setDuration(audioRef.current?.duration || 0);
  }, []);

  const closePlayer = useCallback(() => {
    savePosition();
    audioRef.current?.pause();
    setIsPlaying(false);
    setBook(null);
  }, [savePosition]);

  // Space toggles play/pause when a book is loaded, unless the user is
  // typing in a form field.
  useEffect(() => {
    const handler = (e) => {
      if (e.code !== 'Space' || !book) return;
      const target = document.activeElement;
      const tag = target?.tagName;
      const isEditable = target?.isContentEditable;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isEditable) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [book, togglePlay]);

  const value = useMemo(() => ({
    book,
    fileIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    chapters,
    activeChapterIndex,
    playBook,
    togglePlay,
    seekTo,
    skip,
    nextFile,
    prevFile,
    jumpToChapter,
    setVolume,
    closePlayer,
  }), [
    book, fileIndex, isPlaying, currentTime, duration, volume, chapters, activeChapterIndex,
    playBook, togglePlay, seekTo, skip, nextFile, prevFile, jumpToChapter, setVolume, closePlayer,
  ]);

  return (
    <PlayerContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        style={{ display: 'none' }}
      />
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}
