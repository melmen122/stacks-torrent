import { useState } from 'react';
import { useTorrents } from '../context/TorrentsContext.jsx';
import { formatPercent, formatSpeed } from '../utils/format.js';
import { IconPlay, IconPause, IconTrash } from './icons.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import SafetyBadge from './SafetyBadge.jsx';

export default function TorrentRow({ torrent }) {
  const { pause, resume, remove, safetyReports } = useTorrents();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const pct = formatPercent(torrent.progress);

  // `safety` is undefined on a backend that doesn't support the safety
  // check yet (field absent — render nothing extra), null while metadata
  // is still pending (show "checking…"), or the classification summary
  // once available. See docs/PLAN4.md.
  const hasSafetyField = 'safety' in torrent;
  const safety = torrent.safety;
  const noAudio = !!safety && safety.hasAudio === false;
  const noAudioDanger = noAudio && safety.verdict === 'danger';

  return (
    <li
      className={[
        'torrent-row',
        torrent.done ? 'done' : '',
        noAudio ? 'no-audio' : '',
        noAudioDanger ? 'no-audio-danger' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="torrent-row-main">
        <div className="torrent-name" title={torrent.name}>{torrent.name}</div>

        {noAudio ? (
          <p className="torrent-no-audio-message">
            No audio found — nothing downloaded. This may not be an audiobook.
          </p>
        ) : (
          <>
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
          </>
        )}

        {hasSafetyField && (
          <div className="torrent-safety-row">
            <SafetyBadge
              torrentName={torrent.name}
              safety={safety}
              report={safetyReports[torrent.infoHash]}
            />
          </div>
        )}
      </div>

      <div className="torrent-actions">
        {!torrent.done && !noAudio && (
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
