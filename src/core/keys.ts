import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { HDKey } from "@scure/bip32";
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { NETWORK, p2tr } from "@scure/btc-signer";
import { pubSchnorr, taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { base64ToBytes, bytesToBase64, toHex, utf8 } from "./bytes.ts";
import type { WalletAddress } from "./types.ts";

export const SECRET_AAD = utf8("bcashjr-secret-v1");
export const PRODUCTION_SCRYPT = { N: 2 ** 18, r: 8, p: 1, dkLen: 32 } as const;

// Bound parameters loaded from disk so a damaged or tampered record cannot ask
// the process for unbounded memory or CPU. These limits still accept the former
// N=2^19 setting and leave room for stronger settings in future releases.
const MAX_SCRYPT_MEMORY = 1024 ** 3 + 2 * 1024;
const MAX_SCRYPT_WORK = 2 ** 20 * 8;

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

export interface SecretRecord {
  schema: 1;
  encryption: "xchacha20-poly1305";
  kdf: { name: "scrypt" } & ScryptParameters;
  salt: string;
  nonce: string;
  ciphertext: string;
}

function validStoredScrypt(value: unknown): value is { name: "scrypt" } & ScryptParameters {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<{ name: "scrypt" } & ScryptParameters>;
  if (
    candidate.name !== "scrypt" || !Number.isSafeInteger(candidate.N) ||
    !Number.isSafeInteger(candidate.r) || !Number.isSafeInteger(candidate.p) ||
    !Number.isSafeInteger(candidate.dkLen)
  ) return false;
  const parameters = candidate as { name: "scrypt" } & ScryptParameters;
  if (
    parameters.N < 2 || parameters.N > 2 ** 32 ||
    !Number.isInteger(Math.log2(parameters.N)) || parameters.r < 1 ||
    parameters.p < 1 || parameters.dkLen !== 32
  ) return false;
  const memory = 128 * parameters.r * (parameters.N + parameters.p + 1);
  const work = parameters.N * parameters.r * parameters.p;
  return Number.isSafeInteger(memory) && memory <= MAX_SCRYPT_MEMORY &&
    Number.isSafeInteger(work) && work <= MAX_SCRYPT_WORK;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/u).join(" ");
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function entropyFromMnemonic(mnemonic: string): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid 12-word BIP39 recovery phrase");
  }
  const entropy = mnemonicToEntropy(normalized, wordlist);
  if (entropy.length !== 16) throw new Error("Only 12-word BIP39 recovery phrases are supported");
  return entropy;
}

export function mnemonicFromEntropy(entropy: Uint8Array): string {
  if (entropy.length !== 16) throw new Error("Wallet entropy must contain 16 bytes");
  return entropyToMnemonic(entropy, wordlist);
}

export async function protectEntropy(
  entropy: Uint8Array,
  password: string,
  parameters: ScryptParameters = PRODUCTION_SCRYPT,
): Promise<SecretRecord> {
  if (entropy.length !== 16) throw new Error("Wallet entropy must contain 16 bytes");
  if (!password) throw new Error("Local encryption password is required");
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await scryptAsync(password, salt, { ...parameters, maxmem: MAX_SCRYPT_MEMORY });
  try {
    const ciphertext = xchacha20poly1305(key, nonce, SECRET_AAD).encrypt(entropy);
    return {
      schema: 1,
      encryption: "xchacha20-poly1305",
      kdf: { name: "scrypt", ...parameters },
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

export async function unprotectEntropy(
  record: SecretRecord,
  password: string,
): Promise<Uint8Array> {
  if (
    !record || typeof record !== "object" || record.schema !== 1 ||
    record.encryption !== "xchacha20-poly1305" ||
    !validStoredScrypt(record.kdf) ||
    typeof record.salt !== "string" || typeof record.nonce !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("Wallet secret is malformed");
  }
  if (!password) throw new Error("Local encryption password is required");
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64ToBytes(record.salt);
    nonce = base64ToBytes(record.nonce);
    ciphertext = base64ToBytes(record.ciphertext);
  } catch {
    throw new Error("Wallet secret is malformed");
  }
  if (salt.length !== 16 || nonce.length !== 24 || ciphertext.length !== 32) {
    throw new Error("Wallet secret is malformed");
  }
  const parameters: ScryptParameters = {
    N: record.kdf.N,
    r: record.kdf.r,
    p: record.kdf.p,
    dkLen: record.kdf.dkLen,
  };
  const key = await scryptAsync(password, salt, { ...parameters, maxmem: MAX_SCRYPT_MEMORY });
  try {
    const entropy = xchacha20poly1305(key, nonce, SECRET_AAD).decrypt(ciphertext);
    if (entropy.length !== 16) throw new Error("Stored wallet entropy is malformed");
    return entropy;
  } catch {
    throw new Error("Incorrect password or damaged wallet secret");
  } finally {
    key.fill(0);
  }
}

export class Bip86Keychain {
  #root: HDKey | null;
  #seed: Uint8Array;

  constructor(entropy: Uint8Array) {
    const mnemonic = mnemonicFromEntropy(entropy);
    this.#seed = mnemonicToSeedSync(mnemonic, "");
    this.#root = HDKey.fromMasterSeed(this.#seed);
  }

  derive(branch: 0 | 1, index: number): WalletAddress {
    const { node, path } = this.#deriveNode(branch, index);
    const publicKey = node.publicKey;
    if (!publicKey) throw new Error("Unable to derive BIP86 public key");
    const payment = p2tr(publicKey.slice(1), undefined, NETWORK);
    return {
      address: payment.address,
      scriptPubKey: toHex(payment.script),
      path,
      branch,
      index,
      used: false,
    };
  }

  /** Separate BIP84 key domain for BPUB control (0) and ownership (1). */
  bpubPrivateKey(branch: 0 | 1, index: number): Uint8Array {
    if (
      !Number.isSafeInteger(index) || index < 0 || index >= 0x8000_0000 ||
      (branch !== 0 && branch !== 1)
    ) throw new Error("Invalid BPUB key index");
    const key = this.#requireRoot().derive(`m/84'/0'/0'/${branch}/${index}`).privateKey;
    if (!key) throw new Error("Unable to derive BPUB key");
    return Uint8Array.from(key);
  }

  privateKey(path: string): Uint8Array {
    const root = this.#requireRoot();
    if (!/^m\/86'\/0'\/0'\/[01]\/\d+$/u.test(path)) throw new Error("Unsupported derivation path");
    const key = root.derive(path).privateKey;
    if (!key) throw new Error("Unable to derive BIP86 private key");
    return Uint8Array.from(key);
  }

  internalPublicKey(path: string): Uint8Array {
    const root = this.#requireRoot();
    if (!/^m\/86'\/0'\/0'\/[01]\/\d+$/u.test(path)) throw new Error("Unsupported derivation path");
    const publicKey = root.derive(path).publicKey;
    if (!publicKey) throw new Error("Unable to derive BIP86 public key");
    return Uint8Array.from(publicKey.slice(1));
  }

  tweakedPrivateKey(path: string): Uint8Array {
    const privateKey = this.privateKey(path);
    try {
      return taprootTweakPrivKey(privateKey);
    } finally {
      privateKey.fill(0);
    }
  }

  outputPublicKey(path: string): Uint8Array {
    const tweaked = this.tweakedPrivateKey(path);
    try {
      return pubSchnorr(tweaked);
    } finally {
      tweaked.fill(0);
    }
  }

  destroy(): void {
    this.#seed.fill(0);
    this.#root?.wipePrivateData();
    this.#root = null;
  }

  #deriveNode(branch: 0 | 1, index: number): { node: HDKey; path: string } {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0x8000_0000) {
      throw new RangeError("Address index is out of range");
    }
    const path = `m/86'/0'/0'/${branch}/${index}`;
    return { node: this.#requireRoot().derive(path), path };
  }

  #requireRoot(): HDKey {
    if (!this.#root) throw new Error("Keychain is locked");
    return this.#root;
  }
}
