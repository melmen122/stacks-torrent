// Prominent VirusTotal scan-status indicator for a BookCard.
//
// HONESTY-CRITICAL: `unknown` is the EXPECTED result for the vast majority
// of audiobooks — VirusTotal's database is built from malware samples and
// widely-distributed files, and a personal rip has almost certainly never
// been submitted. It must never look like a warning (red/amber) or like
// reassurance (green) — it shares NO styling with `clean`, ever. It gets
// its own neutral treatment plus a plain-English explanation so the user
// isn't left staring at a cryptic symbol wondering what it means.
//
// `infected` is intentionally NOT rendered here — BookCard's dedicated,
// always-visible `.scan-alert` banner (with the Remove action) is the
// single, maximally-prominent surface for that state, so there's one loud
// signal instead of two competing ones.
export default function ScanBadge({ scan, progress }) {
  if (!scan) return null;

  if (scan.state === 'scanning') {
    const main = progress?.total ? `Scanning ${progress.done ?? 0}/${progress.total}…` : 'Scanning…';
    return (
      <div className="scan-status scan-status-scanning" title="Checking downloaded files against VirusTotal">
        <div className="scan-status-main">
          <span className="scan-status-dot" aria-hidden="true" />
          {main}
        </div>
      </div>
    );
  }

  if (scan.state === 'error') {
    return (
      <div className="scan-status scan-status-error">
        <div className="scan-status-main">
          <span className="scan-status-icon" aria-hidden="true">!</span>
          Scan failed
        </div>
        <p className="scan-status-sub">Try again from the book&rsquo;s ⋯ menu.</p>
      </div>
    );
  }

  if (scan.state !== 'done' || !scan.verdict) return null;

  if (scan.verdict === 'infected') return null; // see comment above

  if (scan.verdict === 'clean') {
    return (
      <div className="scan-status scan-status-clean">
        <div className="scan-status-main">
          <span className="scan-status-icon" aria-hidden="true">✓</span>
          No threats found — checked by VirusTotal
        </div>
      </div>
    );
  }

  if (scan.verdict === 'suspicious') {
    return (
      <div className="scan-status scan-status-suspicious">
        <div className="scan-status-main">
          <span className="scan-status-icon" aria-hidden="true">⚠</span>
          Flagged as suspicious
        </div>
        <p className="scan-status-sub">VirusTotal found this file suspicious but not confirmed malicious.</p>
      </div>
    );
  }

  if (scan.verdict === 'unknown') {
    return (
      <div
        className="scan-status scan-status-unknown"
        title="Normal for audiobooks — VirusTotal only knows files that have been submitted before. No known threats, but not independently verified."
      >
        <div className="scan-status-main">
          <span className="scan-status-icon" aria-hidden="true">i</span>
          Not in VirusTotal&rsquo;s database
        </div>
        <p className="scan-status-sub">
          Normal for audiobooks — VirusTotal only knows files submitted before. No known
          threats, but not independently verified.
        </p>
      </div>
    );
  }

  return null;
}
