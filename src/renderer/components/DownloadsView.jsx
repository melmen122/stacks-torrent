import { useState } from 'react';
import { useTorrents } from '../context/TorrentsContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import TorrentRow from './TorrentRow.jsx';
import EmptyState from './EmptyState.jsx';

function errorMessage(err, fallback) {
  return (err && (err.message || String(err))) || fallback;
}

export default function DownloadsView() {
  const { torrents, addMagnet, addTorrentFile } = useTorrents();
  const { push } = useToast();
  const [magnet, setMagnet] = useState('');
  const [busy, setBusy] = useState(false);

  const submitMagnet = async (e) => {
    e.preventDefault();
    const uri = magnet.trim();
    if (!uri || busy) return;
    setBusy(true);
    try {
      await addMagnet(uri);
      setMagnet(''); // only clear on success; keep the value so the user can fix/retry
    } catch (err) {
      push(errorMessage(err, "Couldn't add that magnet link. Check it and try again."), { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const openTorrentFile = async () => {
    try {
      await addTorrentFile();
    } catch (err) {
      push(errorMessage(err, "Couldn't add that .torrent file."), { type: 'error' });
    }
  };

  return (
    <div className="downloads-view">
      <h1 className="view-title">Downloads</h1>

      <form className="magnet-form" onSubmit={submitMagnet}>
        <input
          type="text"
          aria-label="Magnet link"
          placeholder="Paste a magnet link…"
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!magnet.trim() || busy}>
          Add
        </button>
        <button type="button" className="btn btn-ghost" onClick={openTorrentFile}>
          Open .torrent file…
        </button>
      </form>

      {torrents.length === 0 ? (
        <EmptyState variant="downloads" />
      ) : (
        <ul className="torrent-list">
          {torrents.map((t) => (
            <TorrentRow key={t.infoHash} torrent={t} />
          ))}
        </ul>
      )}
    </div>
  );
}
