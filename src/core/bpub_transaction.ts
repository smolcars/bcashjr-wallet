import { deflateRawSync, inflateRawSync } from "node:zlib";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bpubDataScripts, bpubOwnerScript, bpubP2wsh, encodeBpub } from "../bpub/mod.ts";
import type { BpubCompression } from "../bpub/mod.ts";
import {
  compactSize,
  concatBytes,
  fromHex,
  reverseBytes,
  toHex,
  u32le,
  varBytes,
} from "./bytes.ts";
import type { Bip86Keychain } from "./keys.ts";
import {
  BPUB_MAX_FILE_BYTES,
  BPUB_MIN_FEE_RATE,
  BPUB_MIN_OWNER_VALUE,
  BPUB_OWNER_VALUE,
} from "./bpub_limits.ts";
import {
  createSweepTemplate,
  serializeStripped,
  signUnifiedOutputs,
  type SpendableCoin,
} from "./transaction.ts";
import {
  SIGHASH_ALL_UNIFIED,
  UNIFIED_SCRIPT_TYPE_WITNESS_V0,
  unifiedSignatureHash,
  type UnifiedTransaction,
} from "./unified_sighash.ts";

export const bpubCompression: BpubCompression = {
  deflate: (data) => Uint8Array.from(deflateRawSync(data, { level: 9 })),
  inflate: (data, maxOutputBytes) =>
    Uint8Array.from(inflateRawSync(data, { maxOutputLength: Math.max(1, maxOutputBytes) })),
};
export interface BpubPayload {
  id: string;
  scripts: Uint8Array[];
  ownerScript: Uint8Array;
}
export interface BpubTemplate {
  funding: UnifiedTransaction;
  reveal: UnifiedTransaction;
  coins: SpendableCoin[];
  payload: BpubPayload;
  fundingFee: number;
  revealFee: number;
  fundingVsize: number;
  revealVsize: number;
  fundingChange: number;
  revealReturn: number;
  dataValue: number;
}
export function makeBpubPayload(
  data: Uint8Array,
  filename: string,
  mime: string,
  keychain: Bip86Keychain,
  keyIndex: number,
): BpubPayload {
  const control = keychain.bpubPrivateKey(0, keyIndex);
  const owner = keychain.bpubPrivateKey(1, keyIndex);
  try {
    // Compression is lossless. Use it only if it reduces the actual file payload.
    const encoded = encodeBpub(data, {
      filename,
      mime,
      compress: bpubCompression.deflate(data).length < data.length,
    }, bpubCompression);
    return {
      id: encoded.id,
      scripts: bpubDataScripts(encoded.publicKeys, secp256k1.getPublicKey(control, true)),
      ownerScript: bpubOwnerScript(
        fromHex(encoded.id),
        ripemd160(sha256(secp256k1.getPublicKey(owner, true))),
      ),
    };
  } finally {
    control.fill(0);
    owner.fill(0);
  }
}
export function bpubWire(tx: UnifiedTransaction, witnesses: Uint8Array[][]): Uint8Array {
  if (witnesses.length !== tx.inputs.length) throw new Error("BPUB witness count mismatch");
  const stripped = serializeStripped(tx);
  return concatBytes(
    stripped.slice(0, 4),
    Uint8Array.of(0, 1),
    stripped.slice(4, -4),
    ...witnesses.map((items) => concatBytes(compactSize(items.length), ...items.map(varBytes))),
    u32le(tx.lockTime),
  );
}
export function bpubTxid(tx: UnifiedTransaction): string {
  return toHex(reverseBytes(sha256(sha256(serializeStripped(tx)))));
}
function size(tx: UnifiedTransaction, witnesses: Uint8Array[][]): number {
  const weight = serializeStripped(tx).length * 3 + bpubWire(tx, witnesses).length;
  if (weight > 400_000) {
    throw new Error("BPUB transaction exceeds the standard transaction weight limit");
  }
  return Math.ceil(weight / 4);
}
export function createBpubTemplate(
  coins: SpendableCoin[],
  destination: string,
  feeRate: number,
  lockTime: number,
  payload: BpubPayload,
  ownerValue = BPUB_OWNER_VALUE,
): BpubTemplate {
  if (!Number.isFinite(feeRate) || feeRate < BPUB_MIN_FEE_RATE) {
    throw new Error(`BPUB fee rate must be at least ${BPUB_MIN_FEE_RATE} sat/vB`);
  }
  if (!Number.isSafeInteger(ownerValue) || ownerValue < BPUB_MIN_OWNER_VALUE) {
    throw new Error(
      `BPUB ownership amount must be a whole number of at least ${BPUB_MIN_OWNER_VALUE} sats`,
    );
  }
  const sweep = createSweepTemplate(coins, destination, feeRate, lockTime);
  if (
    sweep.destinationScript.length !== 34 || sweep.destinationScript[0] !== 0x51 ||
    sweep.destinationScript[1] !== 0x20
  ) {
    throw new Error("BPUB returns must use a wallet Taproot address");
  }
  const count = payload.scripts.length;
  if (
    count < 1 || payload.scripts.some((s) => s.length > 513) ||
    payload.scripts.reduce((n, s) => n + s[s.length - 2] - 0x50, 0) > 16000
  ) {
    throw new Error("BPUB scripts exceed relay limits");
  }
  const reveal: UnifiedTransaction = {
    version: 2,
    lockTime,
    inputs: payload.scripts.map((_, index) => ({
      txid: new Uint8Array(32),
      index,
      sequence: 0xffff_fffd,
    })),
    outputs: [{ amount: 330n, script: sweep.destinationScript }],
  };
  const revealVsize = size(
    reveal,
    payload.scripts.map((s) => [new Uint8Array(), new Uint8Array(73), s]),
  );
  const revealFee = Math.ceil(revealVsize * feeRate);
  const dataValue = Math.max(count * 546, revealFee + 330);
  const values = payload.scripts.map((_, index) =>
    546 + (index === 0 ? dataValue - count * 546 : 0)
  );
  const funding: UnifiedTransaction = {
    ...sweep.tx,
    outputs: [
      ...payload.scripts.map((script, index) => ({
        amount: BigInt(values[index]),
        script: bpubP2wsh(script),
      })),
      { amount: BigInt(ownerValue), script: bpubP2wsh(payload.ownerScript) },
      { amount: 330n, script: sweep.destinationScript },
    ],
  };
  const fundingVsize = size(funding, coins.map(() => [new Uint8Array(65)]));
  const fundingFee = Math.ceil(fundingVsize * feeRate);
  const fundingChange = sweep.inputValue - dataValue - ownerValue - fundingFee;
  if (fundingChange < 330) {
    throw new Error(
      "Select more BLAKE: publication costs and wallet change exceed the selected balance",
    );
  }
  funding.outputs.at(-1)!.amount = BigInt(fundingChange);
  const fundingTxid = fromHex(bpubTxid(funding));
  for (const input of reveal.inputs) input.txid = fundingTxid;
  const revealReturn = dataValue - revealFee;
  reveal.outputs[0].amount = BigInt(revealReturn);
  return {
    funding,
    reveal,
    coins: sweep.coins,
    payload,
    fundingFee,
    revealFee,
    fundingVsize,
    revealVsize,
    fundingChange,
    revealReturn,
    dataValue,
  };
}
export function signBpub(template: BpubTemplate, keychain: Bip86Keychain, keyIndex: number) {
  const funding = signUnifiedOutputs(template.funding, template.coins, keychain);
  if (
    funding.txid !== bpubTxid(template.funding) || funding.fee !== template.fundingFee ||
    funding.vsize !== template.fundingVsize
  ) throw new Error("BPUB funding changed while signing");
  const privateKey = keychain.bpubPrivateKey(0, keyIndex);
  try {
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    const spent = template.funding.outputs.slice(0, template.payload.scripts.length);
    const witnesses = template.payload.scripts.map((script, index) => {
      const digest = unifiedSignatureHash(template.reveal, index, SIGHASH_ALL_UNIFIED, spent, {
        scriptType: UNIFIED_SCRIPT_TYPE_WITNESS_V0,
        scriptCode: script,
      });
      if (!digest) throw new Error("Unable to compute BPUB unified sighash");
      const signature = secp256k1.sign(digest, privateKey, {
        prehash: false,
        lowS: true,
        format: "der",
      });
      if (
        !secp256k1.verify(signature, digest, publicKey, {
          prehash: false,
          lowS: true,
          format: "der",
        })
      ) {
        throw new Error("BPUB reveal signature verification failed");
      }
      return [new Uint8Array(), concatBytes(signature, Uint8Array.of(SIGHASH_ALL_UNIFIED)), script];
    });
    if (size(template.reveal, witnesses) > template.revealVsize) {
      throw new Error("BPUB reveal exceeded reviewed size");
    }
    return {
      funding,
      reveal: {
        txid: bpubTxid(template.reveal),
        rawTx: toHex(bpubWire(template.reveal, witnesses)),
      },
    };
  } finally {
    privateKey.fill(0);
  }
}

/** Validate bytes, not just the renderer's MIME claim. Never decode images in the backend. */
export function validateBpubImage(data: Uint8Array, mime: string, filename: string): void {
  if (!data.length || data.length > BPUB_MAX_FILE_BYTES) {
    throw new Error("Choose a picture between 1 byte and 128 KiB");
  }
  if (
    !filename || new TextEncoder().encode(filename).length > 255 ||
    /[\\/]/u.test(filename) ||
    [...filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    throw new Error("Invalid picture filename");
  }
  const prefix = toHex(data.slice(0, 12));
  const valid = mime === "image/png"
    ? prefix.startsWith("89504e470d0a1a0a")
    : mime === "image/jpeg"
    ? prefix.startsWith("ffd8ff")
    : mime === "image/gif"
    ? /^(474946383761|474946383961)/u.test(prefix)
    : mime === "image/webp"
    ? prefix.startsWith("52494646") && prefix.slice(16) === "57454250"
    : false;
  if (!valid) throw new Error("Choose a PNG, JPEG, GIF or WebP picture matching its file type");
}
