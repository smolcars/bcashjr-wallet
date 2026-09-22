import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { SigHash, Transaction } from "@scure/btc-signer";
import { signSchnorr } from "@scure/btc-signer/utils.js";
import {
  compactSize,
  concatBytes,
  equalBytes,
  fromHex,
  i64le,
  reverseBytes,
  toHex,
  u32le,
  varBytes,
} from "./bytes.ts";
import { parseDestinationAddress } from "./destination.ts";
import { Bip86Keychain } from "./keys.ts";
import {
  SIGHASH_ALL_UNIFIED,
  UNIFIED_SCRIPT_TYPE_TAPROOT,
  unifiedSignatureHash,
  type UnifiedTransaction,
} from "./unified_sighash.ts";

export const RBF_SEQUENCE = 0xffff_fffd;
export const MAX_FEE_RATE = 100;
export const HIGH_FEE_RATE = 50;

export function feeNeedsExplicitConfirmation(
  inputValue: number,
  fee: number,
  feeRate: number,
): boolean {
  return feeRate >= HIGH_FEE_RATE || fee * 10 >= inputValue;
}

export interface SpendableCoin {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  path: string;
}

export type SweepMode = "blake-unified" | "btc-standard";

export interface SweepTemplate {
  mode: SweepMode;
  coins: SpendableCoin[];
  destination: string;
  destinationScript: Uint8Array;
  feeRate: number;
  fee: number;
  inputValue: number;
  outputValue: number;
  vsize: number;
  lockTime: number;
  tx: UnifiedTransaction;
}

export interface SignedSweep {
  rawTx: string;
  txid: string;
  vsize: number;
  fee: number;
  outputValue: number;
}

function validateCoin(coin: SpendableCoin): void {
  if (!/^[0-9a-f]{64}$/u.test(coin.txid)) throw new Error(`Invalid transaction id: ${coin.txid}`);
  if (!Number.isSafeInteger(coin.vout) || coin.vout < 0 || coin.vout > 0xffff_ffff) {
    throw new Error("Invalid output index");
  }
  if (!Number.isSafeInteger(coin.value) || coin.value <= 0) throw new Error("Invalid coin value");
  const script = fromHex(coin.scriptPubKey);
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
    throw new Error("Selected coin is not a Taproot output");
  }
}

function sortedCoins(coins: SpendableCoin[]): SpendableCoin[] {
  return [...coins].sort((left, right) =>
    left.txid.localeCompare(right.txid) || left.vout - right.vout
  );
}

export function serializeStripped(tx: UnifiedTransaction): Uint8Array {
  return concatBytes(
    u32le(tx.version >>> 0),
    compactSize(tx.inputs.length),
    ...tx.inputs.map((input) =>
      concatBytes(
        reverseBytes(input.txid),
        u32le(input.index),
        Uint8Array.of(0),
        u32le(input.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((output) => concatBytes(i64le(output.amount), varBytes(output.script))),
    u32le(tx.lockTime),
  );
}

function serializeWithWitness(tx: UnifiedTransaction, witnesses: Uint8Array[]): Uint8Array {
  if (witnesses.length !== tx.inputs.length) throw new Error("Witness count does not match inputs");
  const strippedParts = [
    compactSize(tx.inputs.length),
    ...tx.inputs.map((input) =>
      concatBytes(
        reverseBytes(input.txid),
        u32le(input.index),
        Uint8Array.of(0),
        u32le(input.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((output) => concatBytes(i64le(output.amount), varBytes(output.script))),
  ];
  return concatBytes(
    u32le(tx.version >>> 0),
    Uint8Array.of(0, 1),
    ...strippedParts,
    ...witnesses.map((witness) => concatBytes(Uint8Array.of(1), varBytes(witness))),
    u32le(tx.lockTime),
  );
}

function virtualSize(tx: UnifiedTransaction, witnessSize: number): number {
  const strippedSize = serializeStripped(tx).length;
  const fullSize = serializeWithWitness(
    tx,
    tx.inputs.map(() => new Uint8Array(witnessSize)),
  ).length;
  return Math.ceil((strippedSize * 4 + fullSize - strippedSize) / 4);
}

export function createSweepTemplate(
  requestedCoins: SpendableCoin[],
  destination: string,
  feeRate: number,
  lockTime: number,
  mode: SweepMode = "blake-unified",
): SweepTemplate {
  if (requestedCoins.length === 0) throw new Error("Select at least one output");
  if (!Number.isFinite(feeRate) || feeRate <= 0 || feeRate > MAX_FEE_RATE) {
    throw new Error(`Fee rate must be between 0 and ${MAX_FEE_RATE} sat/vB`);
  }
  if (!Number.isSafeInteger(lockTime) || lockTime < 0 || lockTime > 0xffff_ffff) {
    throw new Error("Invalid locktime");
  }
  requestedCoins.forEach(validateCoin);
  const coins = sortedCoins(requestedCoins);
  const duplicate = coins.find((coin, index) =>
    index > 0 && coin.txid === coins[index - 1].txid && coin.vout === coins[index - 1].vout
  );
  if (duplicate) throw new Error(`Duplicate input ${duplicate.txid}:${duplicate.vout}`);

  const parsedDestination = parseDestinationAddress(destination);
  const script = parsedDestination.script;
  const inputValue = coins.reduce((total, coin) => total + coin.value, 0);
  const provisional: UnifiedTransaction = {
    version: 2,
    lockTime,
    inputs: coins.map((coin) => ({
      txid: fromHex(coin.txid),
      index: coin.vout,
      sequence: RBF_SEQUENCE,
    })),
    outputs: [{ amount: BigInt(inputValue), script }],
  };
  if (mode !== "blake-unified" && mode !== "btc-standard") {
    throw new Error("Unsupported sweep mode");
  }
  const vsize = virtualSize(provisional, mode === "btc-standard" ? 64 : 65);
  const fee = Math.ceil(vsize * feeRate);
  const outputValue = inputValue - fee;
  if (outputValue < parsedDestination.dustLimit) {
    throw new Error(
      `Sweep output would be below the ${parsedDestination.dustLimit}-sat dust limit for this destination`,
    );
  }
  provisional.outputs[0].amount = BigInt(outputValue);
  return {
    mode,
    coins,
    destination: parsedDestination.address,
    destinationScript: script,
    feeRate,
    fee,
    inputValue,
    outputValue,
    vsize,
    lockTime,
    tx: provisional,
  };
}

export function signUnifiedSweep(template: SweepTemplate, keychain: Bip86Keychain): SignedSweep {
  if (template.mode !== "blake-unified") throw new Error("Expected a BLAKE unified sweep");
  return signUnifiedOutputs(template.tx, template.coins, keychain);
}

/** Sign arbitrary outputs without changing the ordinary sweep builder's policy. */
export function signUnifiedOutputs(
  tx: UnifiedTransaction,
  coins: SpendableCoin[],
  keychain: Bip86Keychain,
): SignedSweep {
  const inputValue = coins.reduce((sum, coin) => sum + coin.value, 0);
  const outputValue = tx.outputs.reduce((sum, output) => sum + Number(output.amount), 0);
  if (
    !Number.isSafeInteger(inputValue) || !Number.isSafeInteger(outputValue) ||
    outputValue < 0 || outputValue >= inputValue || tx.inputs.length !== coins.length
  ) {
    throw new Error("Invalid unified transaction amounts");
  }
  for (const [index, coin] of coins.entries()) {
    validateCoin(coin);
    if (toHex(tx.inputs[index].txid) !== coin.txid || tx.inputs[index].index !== coin.vout) {
      throw new Error("Unified input metadata does not match transaction");
    }
  }
  const template = { tx, coins };
  const spentOutputs = template.coins.map((coin) => ({
    amount: BigInt(coin.value),
    script: fromHex(coin.scriptPubKey),
  }));
  const witnesses: Uint8Array[] = [];

  for (let index = 0; index < template.coins.length; index++) {
    const coin = template.coins[index];
    const digest = unifiedSignatureHash(
      template.tx,
      index,
      SIGHASH_ALL_UNIFIED,
      spentOutputs,
      { scriptType: UNIFIED_SCRIPT_TYPE_TAPROOT },
    );
    if (!digest) throw new Error(`Unable to construct unified signature hash for input ${index}`);
    const tweakedPrivateKey = keychain.tweakedPrivateKey(coin.path);
    try {
      const expectedPublicKey = fromHex(coin.scriptPubKey).slice(2);
      const derivedPublicKey = keychain.outputPublicKey(coin.path);
      if (!equalBytes(expectedPublicKey, derivedPublicKey)) {
        throw new Error(`Derivation path does not control input ${coin.txid}:${coin.vout}`);
      }
      const signature = signSchnorr(
        digest,
        tweakedPrivateKey,
        crypto.getRandomValues(new Uint8Array(32)),
      );
      if (!schnorr.verify(signature, digest, expectedPublicKey)) {
        throw new Error(`Local signature verification failed for input ${index}`);
      }
      witnesses.push(concatBytes(signature, Uint8Array.of(SIGHASH_ALL_UNIFIED)));
    } finally {
      tweakedPrivateKey.fill(0);
    }
  }

  const raw = serializeWithWitness(template.tx, witnesses);
  const stripped = serializeStripped(template.tx);
  const txid = toHex(reverseBytes(sha256(sha256(stripped))));
  return {
    rawTx: toHex(raw),
    txid,
    vsize: Math.ceil((stripped.length * 3 + raw.length) / 4),
    fee: inputValue - outputValue,
    outputValue,
  };
}

export const signSweep = signUnifiedSweep;

export function signBtcSweep(template: SweepTemplate, keychain: Bip86Keychain): SignedSweep {
  if (template.mode !== "btc-standard") throw new Error("Expected a standard BTC sweep");
  const tx = new Transaction({ version: template.tx.version, lockTime: template.tx.lockTime });
  const prevOutScripts = template.coins.map((coin) => fromHex(coin.scriptPubKey));
  const amounts = template.coins.map((coin) => BigInt(coin.value));

  for (const coin of template.coins) {
    const expectedPublicKey = fromHex(coin.scriptPubKey).slice(2);
    const derivedPublicKey = keychain.outputPublicKey(coin.path);
    if (!equalBytes(expectedPublicKey, derivedPublicKey)) {
      throw new Error(`Derivation path does not control input ${coin.txid}:${coin.vout}`);
    }
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: {
        amount: BigInt(coin.value),
        script: fromHex(coin.scriptPubKey),
      },
      tapInternalKey: keychain.internalPublicKey(coin.path),
    });
  }
  tx.addOutput({ script: template.destinationScript, amount: BigInt(template.outputValue) });

  for (let index = 0; index < template.coins.length; index++) {
    const coin = template.coins[index];
    const privateKey = keychain.privateKey(coin.path);
    try {
      tx.signIdx(
        privateKey,
        index,
        [SigHash.DEFAULT],
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const signature = tx.getInput(index).tapKeySig;
      if (!signature || signature.length !== 64) {
        throw new Error(`BTC input ${index} did not produce a SIGHASH_DEFAULT signature`);
      }
      const digest = tx.preimageWitnessV1(index, prevOutScripts, SigHash.DEFAULT, amounts);
      const expectedPublicKey = fromHex(coin.scriptPubKey).slice(2);
      if (!schnorr.verify(signature, digest, expectedPublicKey)) {
        throw new Error(`Local BTC signature verification failed for input ${index}`);
      }
    } finally {
      privateKey.fill(0);
    }
  }

  tx.finalize();
  if (tx.vsize !== template.vsize) {
    throw new Error(`BTC transaction size changed from ${template.vsize} to ${tx.vsize} vB`);
  }
  if (tx.fee !== BigInt(template.fee)) throw new Error("BTC transaction fee changed while signing");
  return {
    rawTx: tx.hex,
    txid: tx.id,
    vsize: tx.vsize,
    fee: template.fee,
    outputValue: template.outputValue,
  };
}
