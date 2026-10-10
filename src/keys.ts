/**
 * Split a raw stdin chunk into individual keys. A terminal can deliver several
 * keystrokes in one chunk (paste, or a burst while the UI was busy); without
 * this the whole chunk fails to match any binding and is dropped.
 * CSI escape sequences (`\x1b[` … final byte) stay whole; a lone ESC is a key.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j] ?? '')) j++;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(chunk[i] ?? '');
      i++;
    }
  }
  return keys;
}
