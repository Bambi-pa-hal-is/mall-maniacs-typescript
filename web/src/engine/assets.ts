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
