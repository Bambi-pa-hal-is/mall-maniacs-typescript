/** maniac.cfg, config.mm and quest.txt are obfuscated with a single-byte XOR (AppInit 0x409d90). */
export const XOR_KEY = 0x55;

export function xor55(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ XOR_KEY;
  return out;
}

/** Game text is Swedish Windows-1252 (å, ä, ö). */
export function decodeText(data: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(data);
}
