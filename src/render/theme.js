/** Canvas color tokens. Mirrors the CSS custom properties in ui/styles.css. */
export const themes = {
  light: {
    name: 'light',
    dark: false,
    bg: '#f6f7f9',
    nodeFill: '#ffffff',
    nodeStroke: '#dfe3ea',
    text: '#0f172a',
    muted: '#64748b',
    edge: '#94a3b8',
    accent: '#6366f1',
    flow: 'rgba(255,255,255,0.95)',
    guide: '#f43f5e',
    shadow: 'rgba(15, 23, 42, 0.07)',
    shadowStrong: 'rgba(15, 23, 42, 0.18)',
    labelBg: '#ffffff',
    handleFill: '#ffffff',
  },
  dark: {
    name: 'dark',
    dark: true,
    bg: '#0c0e13',
    nodeFill: '#161a22',
    nodeStroke: '#2a303c',
    text: '#e7e9ef',
    muted: '#8a93a6',
    edge: '#566074',
    accent: '#818cf8',
    flow: 'rgba(255,255,255,0.9)',
    guide: '#fb7185',
    shadow: 'rgba(0, 0, 0, 0.35)',
    shadowStrong: 'rgba(0, 0, 0, 0.6)',
    labelBg: '#161a22',
    handleFill: '#0c0e13',
  },
};

const cache = new Map();
/** `#rrggbb` + alpha → rgba() string (memoized; called many times per frame). */
export function withAlpha(hex, a) {
  const q = Math.round(a * 100) / 100;
  const key = hex + q;
  let v = cache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${q})`;
    if (cache.size > 4000) cache.clear();
    cache.set(key, v);
  }
  return v;
}
