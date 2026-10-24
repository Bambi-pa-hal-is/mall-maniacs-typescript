import manifest from 'virtual:game-manifest';

/** Normalise a game path ("Scene_ica\merged%02d.tpg" style) to its real served file name. */
export function resolveGamePath(path: string): string | undefined {
  const key = path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return manifest.files[key];
}

export function gameFileExists(path: string): boolean {
  return resolveGamePath(path) !== undefined;
}

const cache = new Map<string, Promise<ArrayBuffer>>();

export function loadGameFile(path: string): Promise<ArrayBuffer> {
  const real = resolveGamePath(path);
  if (!real) return Promise.reject(new Error(`Game file not found: ${path}`));
  let p = cache.get(real);
  if (!p) {
    p = fetch(manifest.baseUrl + real.split('/').map(encodeURIComponent).join('/')).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${real}`);
      return r.arrayBuffer();
    });
    cache.set(real, p);
  }
  return p;
}

/**
 * Fetch every game file into the cache (when the page loads), so menus and levels never wait on
 * the network. Reports progress as files done / total.
 */
export async function preloadGameFiles(onProgress: (done: number, total: number) => void, concurrency = 8): Promise<void> {
  const files = Object.values(manifest.files);
  let next = 0;
  let done = 0;
  onProgress(0, files.length);
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      await loadGameFile(file).catch(() => null);
      onProgress(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}
