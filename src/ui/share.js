/**
 * Share links: the diagram travels in the URL fragment, compressed (deflate) and base64url
 * encoded, so nothing is uploaded anywhere. `#d=` opens an editable copy, `#v=` a read-only
 * presentation. DOM-free (CompressionStream exists in browsers and Node).
 */

/** Inflated size limit: a crafted link must not expand into gigabytes. */
const MAX_BYTES = 20 * 1024 * 1024;

export async function encodeDiagram(json) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const packed = await collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return toBase64Url(packed);
}

export async function decodeDiagram(text) {
  const packed = fromBase64Url(text);
  const bytes = await collect(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')), MAX_BYTES);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** `{ mode: 'edit' | 'view', data }` from a location hash, or null. */
export function parseShareHash(hash) {
  const m = /^#(d|v)=([A-Za-z0-9_-]+)$/.exec(hash ?? '');
  return m ? { mode: m[1] === 'v' ? 'view' : 'edit', data: m[2] } : null;
}

async function collect(stream, limit = Infinity) {
  const chunks = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('the shared diagram is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
