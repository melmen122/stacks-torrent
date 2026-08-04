import { useRef, useState } from 'react';
import SafetyDetails from './SafetyDetails.jsx';

const VERDICT_META = {
  clean: { label: 'Audio only', icon: '✓', className: 'safety-badge-clean' },
  caution: { label: 'Caution', icon: '⚠', className: 'safety-badge-caution' },
  danger: { label: 'Blocked risky file', icon: '⛔', className: 'safety-badge-danger' },
};

/**
 * Safety-check badge for a torrent row: reflects `torrent.safety` from
 * `torrents:list` (`{ verdict, hasAudio, skippedCount } | null`). `null`
 * means metadata hasn't arrived yet (still checking) — the caller only
 * renders this component once it knows the field exists at all (see
 * TorrentRow), so "checking" only shows for backends that support the
 * feature, never as a permanently-stuck state on an older backend.
 */
export default function SafetyBadge({ torrentName, safety, report }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);

  if (!safety) {
    return (
      <span className="safety-badge safety-badge-checking" title="Checking downloaded files for safety…">
        <span className="safety-badge-dot" aria-hidden="true" />
        Checking…
      </span>
    );
  }

  const meta = VERDICT_META[safety.verdict] || VERDICT_META.caution;
  const skippedCount = safety.skippedCount || 0;

  if (skippedCount === 0) {
    return (
      <span className={`safety-badge ${meta.className}`} title="Audio-only — nothing else found in this torrent">
        <span aria-hidden="true">{meta.icon}</span> {meta.label}
      </span>
    );
  }

  return (
    <div className="safety-badge-trigger">
      <button
        type="button"
        ref={buttonRef}
        className={`safety-badge safety-badge-button ${meta.className}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${skippedCount} file${skippedCount === 1 ? '' : 's'} skipped — click for details`}
      >
        <span aria-hidden="true">{meta.icon}</span> {meta.label}
        <span className="safety-badge-count">{skippedCount}</span>
      </button>
      {open && (
        <SafetyDetails
          torrentName={torrentName}
          safety={safety}
          report={report}
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
