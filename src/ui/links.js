/** Element links (docs, repos...): parsing and safe opening. DOM-free. */

/** One link per line, trimmed, blanks dropped; null when there are none. */
export function splitLinks(text) {
  const list = String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

/**
 * A link that is safe to open: http(s) only, so a shared diagram can't smuggle in a
 * `javascript:` or `data:` URL. A bare domain ("github.com/acme/api") is read as https.
 */
export function safeUrl(raw) {
  const text = String(raw ?? '').trim();
  const candidates = /^[a-z][a-z0-9+.-]*:/i.test(text) ? [text] : ['https://' + text];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')) return url;
    } catch {
      // Not a URL: nothing to open.
    }
  }
  return null;
}

/** Short name for a link chip: host plus the start of the path. */
export function linkName(url) {
  const name = url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '');
  return name.length > 40 ? name.slice(0, 39) + '…' : name;
}
