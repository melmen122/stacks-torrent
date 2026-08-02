import { useState } from 'react';
import { useTorrents } from '../context/TorrentsContext.jsx';
import { formatPercent, formatSpeed } from '../utils/format.js';
import { IconPlay, IconPause, IconTrash } from './icons.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

export default function TorrentRow({ torrent }) {
  const { pause, resume, remove } = useTorrents();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const pct = formatPercent(torrent.progress);

  return (
    <li className={`torrent-row ${torrent.done ? 'done' : ''}`}>
      <div className="torrent-row-main">
        <div className="torrent-name" title={torrent.name}>{torrent.name}</div>
        <div className="torrent-progress-track">
          <div
            className="torrent-progress-fill"
            style={{ width: `${Math.round((torrent.progress || 0) * 100)}%` }}
          />
        </div>
        <div className="torrent-meta">
          <span>{pct}</span>
          {!torrent.done && <span>{formatSpeed(torrent.downloadSpeed)}</span>}
          {!torrent.done && <span>{torrent.numPeers ?? 0} peers</span>}
          {torrent.done && <span className="torrent-done-label">Completed</span>}
          {torrent.paused && !torrent.done && <span className="torrent-paused-label">Paused</span>}
        </div>
      </div>

      <div className="torrent-actions">
        {!torrent.done && (
          torrent.paused ? (
            <button
              type="button"
              className="icon-button"
              title="Resume"
              aria-label="Resume download"
              onClick={() => resume(torrent.infoHash)}
            >
              <IconPlay />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button"
              title="Pause"
              aria-label="Pause download"
              onClick={() => pause(torrent.infoHash)}
            >
              <IconPause />
            </button>
          )
        )}
        <button
          type="button"
          className="icon-button"
          title="Remove"
          aria-label="Remove download"
          onClick={() => setConfirmingRemove(true)}
        >
          <IconTrash />
        </button>
      </div>

      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove "${torrent.name}"?`}
          message="This stops the download and removes it from this list."
          checkboxLabel="Also delete downloaded files"
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={(deleteFiles) => {
            setConfirmingRemove(false);
            remove(torrent.infoHash, { deleteFiles });
          }}
        />
      )}
    </li>
  );
}
