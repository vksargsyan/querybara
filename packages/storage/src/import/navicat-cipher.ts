import { createDecipheriv, createHash } from 'node:crypto';

/**
 * Navicat's saved-password cipher, for reading connections exported to an `.ncx` file.
 *
 * Navicat 12 and later write AES-128-CBC with a fixed key and IV and PKCS#7 padding, as upper
 * case hex. Navicat 11 wrote Blowfish (key SHA-1("3DC5CA39")) in its own chaining mode with no
 * padding, so the hex is twice the password's length. Both keys are public; the cipher hides
 * nothing from anyone who has the file, which is why the import treats the file as a secret.
 */

const AES_KEY = Buffer.from('libcckeylibcckey', 'latin1');
const AES_IV = Buffer.from('libcciv libcciv ', 'latin1');

/**
 * The password an `.ncx` file holds, or undefined when the text is not one Navicat could have
 * written. An empty field is the empty password.
 */
export function decryptNavicatPassword(hex: string): string | undefined {
  if (hex === '') return '';
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined;
  const data = Buffer.from(hex, 'hex');
  if (data.length % 16 === 0) {
    const aes = decryptAes(data);
    if (aes !== undefined) return aes;
  }
  return utf8(decryptBlowfish(data));
}

function decryptAes(data: Buffer): string | undefined {
  try {
    const decipher = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
    return utf8(Buffer.concat([decipher.update(data), decipher.final()]));
  } catch {
    // Bad padding: not AES, or not Navicat's key.
    return undefined;
  }
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Navicat 11: Blowfish

/** Navicat 11's chaining: XOR with a running vector seeded by encrypting all ones. */
function decryptBlowfish(data: Uint8Array): Uint8Array {
  const cipher = navicat11Cipher();
  const out = new Uint8Array(data.length);
  let vector = cipher.encrypt(new Uint8Array(8).fill(0xff));
  const whole = data.length - (data.length % 8);
  for (let at = 0; at < whole; at += 8) {
    const block = data.subarray(at, at + 8);
    const plain = cipher.decrypt(block);
    for (let i = 0; i < 8; i++) {
      out[at + i] = plain[i]! ^ vector[i]!;
      vector[i] = vector[i]! ^ block[i]!;
    }
  }
  if (whole < data.length) {
    vector = cipher.encrypt(vector);
    for (let i = whole; i < data.length; i++) out[i] = data[i]! ^ vector[i - whole]!;
  }
  return out;
}

let navicat11: Blowfish | undefined;

function navicat11Cipher(): Blowfish {
  navicat11 ??= new Blowfish(createHash('sha1').update('3DC5CA39').digest());
  return navicat11;
}

/**
 * Blowfish (64-bit blocks, big-endian words). Node's OpenSSL keeps Blowfish in its legacy
 * provider, which is off, so it is written out here. Its initial P-array and S-boxes are the
 * hexadecimal digits of pi, computed once instead of tabled.
 */
class Blowfish {
  readonly #p: Uint32Array;
  readonly #s: Uint32Array;

  constructor(key: Uint8Array) {
    const digits = piWords(18 + 4 * 256);
    this.#p = digits.slice(0, 18);
    this.#s = digits.slice(18);
    let k = 0;
    for (let i = 0; i < 18; i++) {
      let word = 0;
      for (let j = 0; j < 4; j++) {
        word = ((word << 8) | key[k]!) >>> 0;
        k = (k + 1) % key.length;
      }
      this.#p[i] = (this.#p[i]! ^ word) >>> 0;
    }
    const pair: [number, number] = [0, 0];
    for (let i = 0; i < 18; i += 2) {
      this.#encryptWords(pair);
      this.#p[i] = pair[0];
      this.#p[i + 1] = pair[1];
    }
    for (let i = 0; i < 1024; i += 2) {
      this.#encryptWords(pair);
      this.#s[i] = pair[0];
      this.#s[i + 1] = pair[1];
    }
  }

  encrypt(block: Uint8Array): Uint8Array {
    const pair = readWords(block);
    this.#encryptWords(pair);
    return writeWords(pair);
  }

  decrypt(block: Uint8Array): Uint8Array {
    const pair = readWords(block);
    let [left, right] = pair;
    for (let i = 17; i > 1; i--) {
      left = (left ^ this.#p[i]!) >>> 0;
      right = (right ^ this.#f(left)) >>> 0;
      [left, right] = [right, left];
    }
    [left, right] = [right, left];
    right = (right ^ this.#p[1]!) >>> 0;
    left = (left ^ this.#p[0]!) >>> 0;
    return writeWords([left, right]);
  }

  #encryptWords(pair: [number, number]): void {
    let [left, right] = pair;
    for (let i = 0; i < 16; i++) {
      left = (left ^ this.#p[i]!) >>> 0;
      right = (right ^ this.#f(left)) >>> 0;
      [left, right] = [right, left];
    }
    [left, right] = [right, left];
    right = (right ^ this.#p[16]!) >>> 0;
    left = (left ^ this.#p[17]!) >>> 0;
    pair[0] = left;
    pair[1] = right;
  }

  #f(x: number): number {
    const s = this.#s;
    const a = s[x >>> 24]!;
    const b = s[256 + ((x >>> 16) & 0xff)]!;
    const c = s[512 + ((x >>> 8) & 0xff)]!;
    const d = s[768 + (x & 0xff)]!;
    return ((((a + b) >>> 0) ^ c) + d) >>> 0;
  }
}

function readWords(block: Uint8Array): [number, number] {
  const view = new DataView(block.buffer, block.byteOffset, 8);
  return [view.getUint32(0), view.getUint32(4)];
}

function writeWords([left, right]: readonly [number, number]): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, left);
  view.setUint32(4, right);
  return out;
}

/** The first `count` 32-bit words of pi's fractional part (Machin's formula, in BigInt). */
function piWords(count: number): Uint32Array {
  const bits = BigInt(count * 32 + 64);
  const one = 1n << bits;
  const arctanInverse = (x: bigint): bigint => {
    let sum = 0n;
    let term = one / x;
    const xx = x * x;
    for (let n = 1n, sign = 1n; term !== 0n; n += 2n, sign = -sign) {
      sum += (sign * term) / n;
      term /= xx;
    }
    return sum;
  };
  const pi = 16n * arctanInverse(5n) - 4n * arctanInverse(239n);
  // Drop the integer part (3), keep the fraction's leading `count` words.
  const fraction = (pi - 3n * one) >> 64n;
  const words = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    words[i] = Number((fraction >> BigInt((count - 1 - i) * 32)) & 0xffffffffn);
  }
  return words;
}
