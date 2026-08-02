// Small inline SVG icon set — no external icon library dependency.
// Stroke icons share a base style; solid icons (play/pause/transport
// controls) use filled paths for a more "player" feel.

const strokeBase = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function IconLibrary(props) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} {...strokeBase} {...props}>
      <path d="M4 19.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v14" />
      <path d="M10 19.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v14" />
      <path d="M4 19.5h12" />
      <path d="M17.5 6.2l3 12.6-3.6.9-3-12.6z" />
    </svg>
  );
}

export function IconDownload(props) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} {...strokeBase} {...props}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

export function IconPlus(props) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} {...strokeBase} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconDots(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" stroke="none" {...props}>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function IconPlay({ playing, ...rest }) {
  if (playing) {
    return (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" stroke="none" {...rest}>
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" stroke="none" {...rest}>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

export function IconPause(props) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" stroke="none" {...props}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function IconPrevTrack(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" stroke="none" {...props}>
      <rect x="5" y="5" width="2.2" height="14" rx="1" />
      <path d="M18 5.5v13L8 12z" />
    </svg>
  );
}

export function IconNextTrack(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" stroke="none" {...props}>
      <rect x="16.8" y="5" width="2.2" height="14" rx="1" />
      <path d="M6 5.5v13l10-6.5z" />
    </svg>
  );
}

export function IconRewind(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" stroke="none" {...props}>
      <path d="M12.5 5.5v13L2.5 12z" />
      <path d="M21.5 5.5v13L11.5 12z" />
    </svg>
  );
}

export function IconFastForward(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" stroke="none" {...props}>
      <path d="M11.5 5.5v13l10-6.5z" />
      <path d="M2.5 5.5v13l10-6.5z" />
    </svg>
  );
}

export function IconVolume(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...strokeBase} {...props}>
      <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

export function IconClose(props) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} {...strokeBase} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconCheck(props) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} {...strokeBase} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function IconSearch(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...strokeBase} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.8-4.8" />
    </svg>
  );
}

export function IconChapters(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...strokeBase} {...props}>
      <path d="M8.5 6h11" />
      <path d="M8.5 12h11" />
      <path d="M8.5 18h11" />
      <path d="M4.5 6h.01" />
      <path d="M4.5 12h.01" />
      <path d="M4.5 18h.01" />
    </svg>
  );
}

export function IconGear(props) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} {...strokeBase} {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.66 6.34l-1.7 1.7M8.04 15.96l-1.7 1.7M17.66 17.66l-1.7-1.7M8.04 8.04l-1.7-1.7" />
    </svg>
  );
}

export function IconTrash(props) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...strokeBase} {...props}>
      <path d="M5 7h14" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M7 7l1 12.5a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1L17 7" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}
