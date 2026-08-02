// Formatting helpers shared across the renderer.

/** "12h 34m" / "45m" / "<1m" / "—" for null/unknown durations. */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—';
  const total = Math.round(totalSeconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0 && m === 0) return '<1m';
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** "1:02:33" (with hours) or "4:05" (without) — for player elapsed/total. */
export function formatClock(seconds) {
  let total = Number.isFinite(seconds) ? seconds : 0;
  if (total < 0) total = 0;
  total = Math.floor(total);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** Human-readable transfer speed, e.g. "1.2 MB/s". */
export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSec;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** 0..1 fraction -> "42%" */
export function formatPercent(fraction) {
  return `${Math.round((fraction || 0) * 100)}%`;
}
