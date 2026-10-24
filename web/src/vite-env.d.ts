/// <reference types="vite/client" />

declare module 'virtual:game-manifest' {
  const manifest: { baseUrl: string; files: Record<string, string>; musicUrl: string; music: Record<number, string> };
  export default manifest;
}
