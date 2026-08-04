import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './ToastContext.jsx';

const TorrentsContext = createContext(null);

// Files that are always safe to skip quietly (cover art, .nfo, subtitles,
// playlists, etc.) — never worth mentioning in a toast, unlike archives/
// executables/unrecognized files which are what "caution"/"danger" mean.
function isNoteworthySkip(file) {
  return file?.category !== 'companion';
}

export function TorrentsProvider({ children }) {
  const [torrents, setTorrents] = useState([]);
  // infoHash -> full { infoHash, name, verdict, hasAudio, downloadedCount,
  // skipped } payload from the last torrents:safety-report event. Kept
  // separately from `torrents` because torrents:list only carries the
  // lightweight `safety: { verdict, hasAudio, skippedCount }` summary, not
  // the per-file skipped list — that only ever arrives via the event.
  const [safetyReports, setSafetyReports] = useState({});
  const { push } = useToast();

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;

    api.torrentsList().then((list) => {
      if (!cancelled) setTorrents(list || []);
    });

    const unsubProgress = api.onTorrentsProgress?.((list) => setTorrents(list || []));
    const unsubDone = api.onTorrentsDone?.((info) => {
      push(`Added to library: ${info?.name || 'book'}`, { type: 'success' });
    });
    const unsubSafety = api.onSafetyReport?.((report) => {
      if (!report?.infoHash) return;
      setSafetyReports((prev) => ({ ...prev, [report.infoHash]: report }));

      const noteworthy = (report.skipped || []).filter(isNoteworthySkip);
      const audioNote = report.hasAudio === false
        ? ' No audio was found — nothing was downloaded.'
        : ' Downloaded audio only.';

      if (report.verdict === 'danger') {
        const worst = noteworthy.find((f) => f.category === 'executable' || f.category === 'disguised') || noteworthy[0];
        push(
          `⛔ Blocked a suspicious file in "${report.name}"${worst ? `: ${worst.name}` : ''}.${audioNote}`,
          { type: 'error', duration: 9000 },
        );
      } else if (report.verdict === 'caution') {
        push(
          `⚠ Skipped ${noteworthy.length} non-audio file${noteworthy.length === 1 ? '' : 's'} in "${report.name}".${audioNote}`,
          { type: 'info', duration: 6000 },
        );
      }
      // clean: no toast — nothing risky happened, avoid noise.
    });

    return () => {
      cancelled = true;
      unsubProgress?.();
      unsubDone?.();
      unsubSafety?.();
    };
  }, [push]);

  const addMagnet = useCallback((uri) => api?.torrentsAdd(uri), []);
  const addTorrentFile = useCallback(() => api?.torrentsAdd(null), []);
  const pause = useCallback((infoHash) => api?.torrentsPause(infoHash), []);
  const resume = useCallback((infoHash) => api?.torrentsResume(infoHash), []);
  const remove = useCallback((infoHash, opts) => api?.torrentsRemove(infoHash, opts), []);

  const value = { torrents, safetyReports, addMagnet, addTorrentFile, pause, resume, remove };
  return <TorrentsContext.Provider value={value}>{children}</TorrentsContext.Provider>;
}

export function useTorrents() {
  const ctx = useContext(TorrentsContext);
  if (!ctx) throw new Error('useTorrents must be used within a TorrentsProvider');
  return ctx;
}
