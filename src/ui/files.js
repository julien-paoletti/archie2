/**
 * Saving to real files with the File System Access API (Chrome, Edge): a file handle lets
 * Save write back to the same file instead of downloading a new copy each time. The handle
 * is remembered in IndexedDB so it survives reloads (the browser asks again for write
 * permission on first use). Browsers without the API fall back to downloads and <input>.
 */

export const supported = typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;

const TYPES = [{ description: 'Archie diagram', accept: { 'application/json': ['.json'] } }];
const aborted = (err) => err?.name === 'AbortError';

/** Native "Save as" dialog. Resolves to a handle, or null if the user cancelled. */
export async function pickSave(suggestedName, startIn) {
  try {
    return await window.showSaveFilePicker({ suggestedName, types: TYPES, ...(startIn ? { startIn } : {}) });
  } catch (err) {
    if (aborted(err)) return null;
    throw err;
  }
}

/** Native "Open" dialog. Resolves to a handle, or null if the user cancelled. */
export async function pickOpen(startIn) {
  try {
    const [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false, ...(startIn ? { startIn } : {}) });
    return handle ?? null;
  } catch (err) {
    if (aborted(err)) return null;
    throw err;
  }
}

/** Make sure we may write to `handle` (prompts if needed; must run from a user gesture). */
async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

/** Replace the file's content. Throws if permission is refused or writing fails. */
export async function writeFile(handle, text) {
  if (!(await ensureWritable(handle))) {
    throw Object.assign(new Error('Permission to write the file was not granted'), { name: 'NotAllowedError' });
  }
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

// ── Remembering the current file across reloads (handles can be stored in IndexedDB).

function store(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('archie', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('handles', mode);
        const req = run(tx.objectStore('handles'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err); // e.g. a value that can't be stored
      }
    };
  });
}

export async function rememberHandle(handle) {
  try {
    await store('readwrite', (s) => (handle ? s.put(handle, 'current') : s.delete('current')));
  } catch {
    // Private mode or storage disabled: the binding just won't survive a reload.
  }
}

export async function recallHandle() {
  try {
    return (await store('readonly', (s) => s.get('current'))) ?? null;
  } catch {
    return null;
  }
}
