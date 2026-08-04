import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './ToastContext.jsx';
import { useLibrary } from './LibraryContext.jsx';

const VirusTotalContext = createContext(null);

/**
 * VirusTotal is the SECOND, opt-in safety layer (see docs/PLAN4B.md): after
 * a torrent's audio files finish downloading, their hashes — never file
 * contents — are looked up on VirusTotal to catch known malware that the
 * pre-download manifest check (Phase 4) can't see inside a file that's
 * already valid audio. Disabled unless the user supplies their own API key
 * in Settings. This is the one feature in the app that talks to an
 * external service.
 */
export function VirusTotalProvider({ children }) {
  const [settings, setSettings] = useState({ enabled: false, hasKey: false });
  const [settingsLoading, setSettingsLoading] = useState(true);
  // bookId -> { done, total } while a scan is actively running (from
  // onScanProgress). Intentionally NOT persisted anywhere — purely a live
  // in-session indicator, cleared once onScanComplete fires for that book.
  const [progress, setProgress] = useState({});
  // bookId -> scan result, optimistically applied from onScanComplete (and
  // scanBook()) so the badge updates immediately. `book.scan` (from
  // LibraryContext, persisted in library.json) is the source of truth on
  // every subsequent library refetch; this cache just bridges the gap
  // until then, same pattern as PlayerContext's position cache /
  // TorrentsContext's safetyReports cache.
  const [scanOverrides, setScanOverrides] = useState({});
  const { push } = useToast();
  const { books } = useLibrary();

  const refetchSettings = useCallback(async () => {
    if (!api?.virusTotalGetSettings) {
      setSettingsLoading(false);
      return;
    }
    try {
      const result = await api.virusTotalGetSettings();
      setSettings({ enabled: !!result?.enabled, hasKey: !!result?.hasKey });
    } catch {
      // Leave whatever settings we last had; nothing meaningful to show.
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetchSettings();
  }, [refetchSettings]);

  useEffect(() => {
    if (!api) return undefined;

    const unsubProgress = api.onScanProgress?.((payload) => {
      const { bookId, done, total } = payload || {};
      if (!bookId) return;
      setProgress((prev) => ({ ...prev, [bookId]: { done, total } }));
    });

    const unsubComplete = api.onScanComplete?.((payload) => {
      const { bookId, verdict, infectedFiles } = payload || {};
      if (!bookId) return;

      setProgress((prev) => {
        if (!(bookId in prev)) return prev;
        const next = { ...prev };
        delete next[bookId];
        return next;
      });

      setScanOverrides((prev) => ({
        ...prev,
        [bookId]: { state: 'done', verdict: verdict ?? 'unknown', scannedAt: Date.now() },
      }));

      // The event payload doesn't carry a book title (just bookId) — look
      // it up from the library list we already have.
      const bookTitle = books.find((b) => b.id === bookId)?.title || 'a book';

      // Progress ticks stay silent (see onScanProgress above) — only the
      // final verdict is worth interrupting the user for, and only when
      // it's not reassuring. 'clean' and 'unknown' get no toast: an
      // "unknown" verdict is NOT a clean bill of health (VT simply has no
      // record of the file), so it must never be announced the way a
      // reassuring result would be.
      if (verdict === 'infected') {
        const worst = infectedFiles?.[0]?.name;
        push(
          `⛔ Infected file detected in "${bookTitle}"${worst ? `: ${worst}` : ''}. `
          + 'It was NOT removed automatically — open the book’s ⋯ menu in your library to remove it.',
          { type: 'error', duration: 12000 },
        );
      } else if (verdict === 'suspicious') {
        push(
          `⚠ VirusTotal flagged a file as suspicious in "${bookTitle}" — check the book for details.`,
          { type: 'info', duration: 7000 },
        );
      }
    });

    return () => {
      unsubProgress?.();
      unsubComplete?.();
    };
    // `books` is read inside onScanComplete purely to resolve a title for
    // the toast — re-subscribing when it changes keeps that lookup fresh
    // (cheap: just an IPC listener swap, not a network call).
  }, [push, books]);

  const setKey = useCallback(async (key) => {
    if (!api?.virusTotalSetKey) return { ok: false, valid: false, reason: 'unsupported' };
    const result = await api.virusTotalSetKey(key);
    await refetchSettings();
    return result;
  }, [refetchSettings]);

  const scanBook = useCallback(async (bookId) => {
    if (!api?.virusTotalScanBook) return { queued: false };
    const result = await api.virusTotalScanBook(bookId);
    if (result?.queued) {
      // Immediate feedback — don't wait for the first progress tick, which
      // can be delayed behind the rate limit queue.
      setScanOverrides((prev) => ({
        ...prev,
        [bookId]: { ...(prev[bookId] || {}), state: 'scanning', verdict: null },
      }));
    }
    return result;
  }, []);

  const value = { settings, settingsLoading, progress, scanOverrides, setKey, scanBook, refetchSettings };
  return <VirusTotalContext.Provider value={value}>{children}</VirusTotalContext.Provider>;
}

export function useVirusTotal() {
  const ctx = useContext(VirusTotalContext);
  if (!ctx) throw new Error('useVirusTotal must be used within a VirusTotalProvider');
  return ctx;
}
