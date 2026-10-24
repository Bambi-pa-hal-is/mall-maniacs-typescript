/// <reference types="vite/client" />

declare module 'virtual:game-manifest' {
  const manifest: { baseUrl: string; files: Record<string, string>; musicUrl: string; music: Record<number, string>;
    /** web/customcharachters/characters.json, when present (see game/customCharacters.ts). */
    custom: { baseUrl: string; characters: unknown } | null;
  };
  export default manifest;
}
