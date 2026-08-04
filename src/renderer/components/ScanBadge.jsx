// Small VirusTotal scan-status pill for a BookCard.
//
// HONESTY-CRITICAL: `unknown` (VirusTotal has no record of this file's
// hash) must never be styled or worded like `clean`. It is not a safety
// signal either way — just an absence of data — so it gets its own
// neutral treatment, visually distinct from both the green "clean" state
// and the red/amber risk states.
const VERDICT_META = {
  clean: { label: 'Clean', icon: '✓', className: 'scan-badge-clean' },
  unknown: { label: 'Unknown to VirusTotal', icon: '?', className: 'scan-badge-unknown' },
  suspicious: { label: 'Suspicious', icon: '⚠', className: 'scan-badge-suspicious' },
  infected: { label: 'Infected', icon: '⛔', className: 'scan-badge-infected' },
};

export default function ScanBadge({ scan, progress }) {
  if (!scan) return null;

  if (scan.state === 'scanning') {
    const label = progress?.total ? `Scanning ${progress.done ?? 0}/${progress.total}…` : 'Scanning…';
    return (
      <span className="scan-badge scan-badge-scanning" title="Checking downloaded files against VirusTotal">
        <span className="scan-badge-dot" aria-hidden="true" />
        {label}
      </span>
    );
  }

  if (scan.state === 'error') {
    return (
      <span className="scan-badge scan-badge-error" title="The virus scan couldn't complete — it will be retried">
        <span aria-hidden="true">!</span> Scan failed
      </span>
    );
  }

  if (scan.state !== 'done' || !scan.verdict) return null;

  const meta = VERDICT_META[scan.verdict];
  if (!meta) return null;

  const title = scan.verdict === 'unknown'
    ? "Not in VirusTotal's database — this does not mean it's safe, just that VirusTotal has no record of it"
    : `VirusTotal verdict: ${meta.label}`;

  return (
    <span className={`scan-badge ${meta.className}`} title={title}>
      <span aria-hidden="true">{meta.icon}</span> {meta.label}
    </span>
  );
}
