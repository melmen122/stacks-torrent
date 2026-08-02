// Deterministic gradient + initials generator used for book covers that
// have no embedded artwork.

const GRADIENT_PALETTE = [
  ['#f2a541', '#c9722c'],
  ['#5b8def', '#2b4c8c'],
  ['#e85d75', '#a13655'],
  ['#4fb0a5', '#276b63'],
  ['#a875e8', '#5c3a91'],
  ['#e8c93f', '#a68a1f'],
  ['#4f9ce8', '#2a5f9e'],
  ['#e87d4f', '#a3502a'],
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Deterministic diagonal gradient for a given seed string (e.g. title+author). */
export function gradientFor(seed) {
  const [from, to] = GRADIENT_PALETTE[hashString(seed || '') % GRADIENT_PALETTE.length];
  return `linear-gradient(155deg, ${from}, ${to})`;
}

/** One or two-letter initials for a book title, e.g. "Dune" -> "DU". */
export function initialsFor(title) {
  if (!title) return '?';
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
