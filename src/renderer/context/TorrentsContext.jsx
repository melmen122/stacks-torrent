import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './ToastContext.jsx';

const TorrentsContext = createContext(null);

export function TorrentsProvider({ children }) {
  const [torrents, setTorrents] = useState([]);
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

    return () => {
      cancelled = true;
      unsubProgress?.();
      unsubDone?.();
    };
  }, [push]);

  const addMagnet = useCallback((uri) => api?.torrentsAdd(uri), []);
  const addTorrentFile = useCallback(() => api?.torrentsAdd(null), []);
  const pause = useCallback((infoHash) => api?.torrentsPause(infoHash), []);
  const resume = useCallback((infoHash) => api?.torrentsResume(infoHash), []);
  const remove = useCallback((infoHash, opts) => api?.torrentsRemove(infoHash, opts), []);

  const value = { torrents, addMagnet, addTorrentFile, pause, resume, remove };
  return <TorrentsContext.Provider value={value}>{children}</TorrentsContext.Provider>;
}

export function useTorrents() {
  const ctx = useContext(TorrentsContext);
  if (!ctx) throw new Error('useTorrents must be used within a TorrentsProvider');
  return ctx;
}
