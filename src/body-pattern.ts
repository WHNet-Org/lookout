export const MAX_BODY_BYTES = 16 * 1024;

const metacharacters = "\\.^$|?*+()[]{}";
const prefixes = new Map<string, Uint8Array | null>();
const bom = [0xef, 0xbb, 0xbf];

function parsePrefix(pattern: string): Uint8Array | null {
  if (!pattern.startsWith("^") || pattern.length === 1) return null;
  const bytes: number[] = [];
  for (let index = 1; index < pattern.length; index++) {
    if (bytes.length === MAX_BODY_BYTES) return null;
    let character = pattern[index];
    if (character === "\\") {
      character = pattern[++index];
      if (!character || !metacharacters.includes(character)) return null;
    } else {
      const code = character.charCodeAt(0);
      if (code < 0x20 || code > 0x7e || metacharacters.includes(character)) return null;
    }
    bytes.push(character.charCodeAt(0));
  }
  return Uint8Array.from(bytes);
}

// Accept only start-anchored printable ASCII literals and their escaped RE2
// metacharacters. Everything else uses the normal RE2 engine.
export function asciiLiteralPrefix(pattern: string): Uint8Array | null {
  let prefix = prefixes.get(pattern);
  if (prefix === undefined) {
    prefix = parsePrefix(pattern);
    prefixes.set(pattern, prefix);
  }
  return prefix;
}

export class AsciiPrefixMatch {
  private readonly prefix: Uint8Array;
  private offset = 0;
  private bomOffset = 0;
  private mismatch = false;

  constructor(prefix: Uint8Array) {
    this.prefix = prefix;
  }

  get matched(): boolean {
    return this.offset === this.prefix.length;
  }

  read(bytes: Uint8Array): void {
    if (this.mismatch || this.matched) return;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (this.bomOffset >= 0) {
        if (byte === bom[this.bomOffset]) {
          this.bomOffset++;
          if (this.bomOffset === bom.length) this.bomOffset = -1;
          continue;
        }
        // An incomplete BOM decodes to U+FFFD, which cannot start an ASCII literal.
        if (this.bomOffset > 0) {
          this.mismatch = true;
          return;
        }
        this.bomOffset = -1;
      }
      if (byte !== this.prefix[this.offset]) {
        this.mismatch = true;
        return;
      }
      this.offset++;
      if (this.matched) return;
    }
  }
}
