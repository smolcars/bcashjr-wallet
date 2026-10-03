import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** Inject raw DEFLATE so the codec works in browsers, Node and Deno. */
export interface BpubCompression {
  deflate(data: Uint8Array): Uint8Array;
  inflate(data: Uint8Array, maxOutputBytes: number): Uint8Array;
}
export interface BpubMetadata {
  bpub_id: string;
  mime?: string;
  filename?: string;
}
export interface BpubEncoding {
  id: string;
  stream: Uint8Array;
  publicKeys: Uint8Array[];
}
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FIELD = (1n << 256n) - (1n << 32n) - 977n;
const SALT = Uint8Array.of(0x53, 0x6a, 0x19, 0xa1);
const MAX_METADATA_BYTES = 65535;
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function be(value: bigint, length: number): Uint8Array {
  const result = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    result[i] = Number(value & 255n);
    value >>= 8n;
  }
  if (value !== 0n) throw new Error("BPUB length overflow");
  return result;
}
function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  while (exponent) {
    if (exponent & 1n) result = result * base % FIELD;
    base = base * base % FIELD;
    exponent >>= 1n;
  }
  return result;
}
function xor(data: Uint8Array): Uint8Array {
  return data.map((byte, index) => byte ^ SALT[index % SALT.length]);
}
export function bpubId(data: Uint8Array): string {
  return hex(sha256(concat(utf8.encode("BPUB5"), sha256(data), be(BigInt(data.length), 8))));
}

/** Reference-compatible 31-byte chunks and deterministic one-byte nonce grinding. */
export function encodeDataKeys(stream: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < stream.length; offset += 31) {
    const xBytes = new Uint8Array(32);
    xBytes.set(stream.subarray(offset, offset + 31));
    let encoded = false;
    for (let nonce = 0; nonce < 256; nonce++) {
      xBytes[31] = nonce;
      const x = BigInt(`0x${hex(xBytes)}`);
      if (x >= FIELD) continue;
      const rhs = (x * x % FIELD * x + 7n) % FIELD;
      const y = pow(rhs, (FIELD + 1n) / 4n);
      if (y === 0n || y * y % FIELD !== rhs) continue;
      result.push(concat(Uint8Array.of(2 | Number(y & 1n)), xBytes));
      encoded = true;
      break;
    }
    if (!encoded) throw new Error("BPUB could not encode a data chunk");
  }
  return result;
}

/** BPUB reference: djkazic/bpub @ 8b1ff26adf336bbd6a0e8a9f0a8b90f7323cbc62. */
export function encodeBpub(
  data: Uint8Array,
  options: { mime?: string; filename?: string; compress?: boolean },
  compression: BpubCompression,
): BpubEncoding {
  const id = bpubId(data);
  const metadata: BpubMetadata = { bpub_id: id };
  if (options.mime) metadata.mime = options.mime;
  if (options.filename) metadata.filename = options.filename;
  // Python json.dumps defaults to ensure_ascii=True, including surrogate pairs.
  const json = JSON.stringify(metadata).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const metadataBytes = utf8.encode(json);
  if (metadataBytes.length > MAX_METADATA_BYTES) {
    throw new Error("BPUB metadata is too large");
  }
  const meta = xor(compression.deflate(metadataBytes));
  if (meta.length > MAX_METADATA_BYTES) throw new Error("BPUB metadata is too large");
  const compressed = Boolean(options.compress && data.length);
  const content = xor(compressed ? compression.deflate(data) : data);
  const body = concat(
    Uint8Array.of(5, compressed ? 3 : 2),
    be(BigInt(data.length), 8),
    sha256(data),
    be(BigInt(meta.length), 2),
    meta,
    content,
  );
  const stream = concat(be(BigInt(body.length), 4), body);
  return { id, stream, publicKeys: encodeDataKeys(stream) };
}

export function decodeBpub(
  publicKeys: Uint8Array[],
  compression: BpubCompression,
  maxContentBytes: number,
): { metadata: BpubMetadata; data: Uint8Array } {
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new Error("Invalid decode limit");
  }
  const bytes = concat(...publicKeys.map((key) => {
    if (key.length !== 33) throw new Error("Invalid BPUB public key");
    secp256k1.Point.fromBytes(key);
    return key.slice(1, 32);
  }));
  if (bytes.length < 48) throw new Error("Truncated BPUB stream");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = 4 + view.getUint32(0);
  const size = view.getBigUint64(6);
  const metaEnd = 48 + view.getUint16(46);
  if (
    bytes[4] !== 5 || (bytes[5] & ~3) !== 0 || !(bytes[5] & 2) ||
    size > BigInt(maxContentBytes) || end > bytes.length || metaEnd > end
  ) {
    throw new Error("Invalid or oversized BPUB v5 stream");
  }
  const metadata = JSON.parse(
    decoder.decode(compression.inflate(xor(bytes.slice(48, metaEnd)), MAX_METADATA_BYTES)),
  );
  const content = xor(bytes.slice(metaEnd, end));
  const data = bytes[5] & 1 ? compression.inflate(content, maxContentBytes) : content;
  if (
    BigInt(data.length) !== size || hex(sha256(data)) !== hex(bytes.slice(14, 46)) ||
    !metadata || metadata.bpub_id !== bpubId(data) ||
    (metadata.mime !== undefined && typeof metadata.mime !== "string") ||
    (metadata.filename !== undefined && typeof metadata.filename !== "string")
  ) {
    throw new Error("BPUB content or metadata integrity check failed");
  }
  return { metadata, data };
}

export function bpubDataScripts(publicKeys: Uint8Array[], controlKey: Uint8Array): Uint8Array[] {
  if (controlKey.length !== 33 || !publicKeys.length) throw new Error("Invalid BPUB keys");
  secp256k1.Point.fromBytes(controlKey);
  return Array.from({ length: Math.ceil(publicKeys.length / 14) }, (_, index) => {
    const keys = [...publicKeys.slice(index * 14, index * 14 + 14), controlKey];
    for (const key of keys) {
      if (key.length !== 33) throw new Error("Invalid BPUB data key");
      secp256k1.Point.fromBytes(key);
    }
    return concat(
      Uint8Array.of(0x51),
      ...keys.map((key) => concat(Uint8Array.of(33), key)),
      Uint8Array.of(0x50 + keys.length, 0xae),
    );
  });
}
export function bpubOwnerScript(id: Uint8Array, ownerHash160: Uint8Array): Uint8Array {
  if (id.length !== 32 || ownerHash160.length !== 20) throw new Error("Invalid BPUB owner");
  return concat(
    Uint8Array.of(32),
    id,
    Uint8Array.of(0x75, 0x76, 0xa9, 20),
    ownerHash160,
    Uint8Array.of(0x88, 0xac),
  );
}
export function bpubP2wsh(script: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0, 32), sha256(script));
}
