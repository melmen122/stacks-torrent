import { useState } from 'react';
import { useTorrents } from '../context/TorrentsContext.jsx';
import { formatPercent, formatSpeed } from '../utils/format.js';
import { IconPlay, IconPause, IconTrash } from './icons.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import SafetyBadge from './SafetyBadge.jsx';

// `torrent.discovery: 'searching' | 'no-peers' | 'connected'` — present on
// every torrentsList()/torrentsAdd()/torrentsPause()/torrentsResume() entry
// and each onTorrentsProgress() item. 'no-peers' covers two distinct
// situations with no separate flag to tell them apart, so we derive which
// one from `progress` ourselves: never got anywhere (progress === 0, dead
// swarm) vs. was downloading and the swarm dried up mid-way (progress > 0,
// stalled). 'connected' also covers progress === 1 (finished — needs no
// seeders), and recovery out of 'no-peers' is immediate/non-latching the
// instant a peer reappears, so this is re-derived fresh on every render
// rather than cached anywhere. Optional-chained throughout so an older
// summary lacking the field renders nothing extra.
function discoveryMessage(torrent) {
  const state = torrent?.discovery;
  if (!state || state === 'connected') return null;

  if (state === 'searching') {
    return { text: 'Searching for peers…', variant: 'searching' };
  }

  if (state === 'no-peers') {
    if ((torrent.progress || 0) > 0) {
      return { text: 'Stalled — no peers connected.', variant: 'stalled' };
    }
    return {
      text: 'No peers found — nobody appears to be sharing this torrent right now. It may be dead, or seeders may come online later.',
      variant: 'no-peers',
    };
  }

  return null;
}

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

  // Only surfaced while the torrent is actively trying to download (not
  // paused, not already done — a dead swarm on a paused/finished torrent
  // isn't actionable information right now).
  const discovery = !torrent.paused && !torrent.done && !noAudio ? discoveryMessage(torrent) : null;

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
            {discovery && (
              <p className={`torrent-discovery-message torrent-discovery-${discovery.variant}`}>
                {discovery.text}
              </p>
            )}
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
