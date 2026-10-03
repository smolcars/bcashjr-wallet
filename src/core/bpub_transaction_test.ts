import { RawTx, Transaction } from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { decodeBpub } from "../bpub/mod.ts";
import { Bip86Keychain } from "./keys.ts";
import {
  bpubCompression,
  createBpubTemplate,
  makeBpubPayload,
  signBpub,
  validateBpubImage,
} from "./bpub_transaction.ts";
import { fromHex, toHex } from "./bytes.ts";
import {
  SIGHASH_ALL_UNIFIED,
  UNIFIED_SCRIPT_TYPE_WITNESS_V0,
  unifiedSignatureHash,
} from "./unified_sighash.ts";
const keychain = () => new Bip86Keychain(new Uint8Array(16));
const image = Uint8Array.from([
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61,
  ...new Uint8Array(800).fill(42),
]);
function throws(fn: () => unknown) {
  let rejected = false;
  try {
    fn();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Expected rejection");
}

Deno.test("BPUB funding and reveal preserve amounts and sign every input with unified sighash", () => {
  const keys = keychain();
  try {
    const address = keys.derive(0, 0);
    const coins = [2, 1].map((n) => ({
      txid: n.toString().repeat(64),
      vout: 0,
      value: 100_000,
      scriptPubKey: address.scriptPubKey,
      path: address.path,
    }));
    const payload = makeBpubPayload(image, "example.gif", "image/gif", keys, 0);
    const template = createBpubTemplate(coins, address.address, 3, 970000, payload);
    const signed = signBpub(template, keys, 0);
    const funding = RawTx.decode(fromHex(signed.funding.rawTx));
    const reveal = RawTx.decode(fromHex(signed.reveal.rawTx));
    const count = payload.scripts.length;
    if (
      funding.inputs.length !== 2 || funding.outputs.length !== count + 2 ||
      reveal.inputs.length !== count ||
      reveal.outputs.length !== 1 ||
      template.fundingChange + template.revealReturn + 330 + template.fundingFee +
            template.revealFee !== 200000
    ) {
      throw new Error("Unexpected BPUB balance or output count");
    }
    if (Number(funding.outputs[count].amount) !== 330 || Number(reveal.outputs[0].amount) < 330) {
      throw new Error("Dust or missing ownership");
    }
    const btcFunding = Transaction.fromRaw(fromHex(signed.funding.rawTx), {
      allowUnknownOutputs: true,
    });
    for (let i = 0; i < funding.inputs.length; i++) {
      const sig = funding.witnesses![i][0];
      if (sig.length !== 65 || sig[64] !== 0x21) throw new Error("Funding is not unified");
      const btcHash = btcFunding.preimageWitnessV1(
        i,
        coins.map((c) => fromHex(c.scriptPubKey)),
        0,
        coins.map((c) => BigInt(c.value)),
      );
      if (schnorr.verify(sig.slice(0, 64), btcHash, fromHex(address.scriptPubKey).slice(2))) {
        throw new Error("Funding verified as BTC default");
      }
    }
    const control = keys.bpubPrivateKey(0, 0);
    const pub = secp256k1.getPublicKey(control, true);
    control.fill(0);
    const recoveredKeys: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const [dummy, signature, script] = reveal.witnesses![i];
      if (
        dummy.length || signature.at(-1) !== 0x21 || toHex(script) !== toHex(payload.scripts[i])
      ) throw new Error("Wrong reveal witness");
      const hash = unifiedSignatureHash(
        template.reveal,
        i,
        SIGHASH_ALL_UNIFIED,
        template.funding.outputs.slice(0, count),
        { scriptType: UNIFIED_SCRIPT_TYPE_WITNESS_V0, scriptCode: script },
      )!;
      if (!secp256k1.verify(signature.slice(0, -1), hash, pub, { prehash: false, format: "der" })) {
        throw new Error("Bad ECDSA reveal signature");
      }
      for (let offset = 1; offset < script.length - 36; offset += 34) {
        recoveredKeys.push(script.slice(offset + 1, offset + 34));
      }
    }
    if (toHex(decodeBpub(recoveredKeys, bpubCompression, 131072).data) !== toHex(image)) {
      throw new Error("Reveal did not recover the picture");
    }
  } finally {
    keys.destroy();
  }
});
Deno.test("BPUB budgets high reveal fees in advance and rejects insufficient funds", () => {
  const keys = keychain();
  try {
    const a = keys.derive(0, 0);
    const payload = makeBpubPayload(image, "a.gif", "image/gif", keys, 0);
    const coin = {
      txid: "11".repeat(32),
      vout: 0,
      value: 1_000_000,
      path: a.path,
      scriptPubKey: a.scriptPubKey,
    };
    const t = createBpubTemplate([coin], a.address, 100, 0, payload, 10000);
    if (t.dataValue < t.revealFee + 330 || t.revealReturn < 330) {
      throw new Error("Reveal is underfunded");
    }
    throws(() => createBpubTemplate([{ ...coin, value: 1000 }], a.address, 3, 0, payload));
    throws(() => createBpubTemplate([coin, coin], a.address, 3, 0, payload));
    for (const feeRate of [0.1, 0.999, 0, -1, NaN]) {
      throws(() => createBpubTemplate([coin], a.address, feeRate, 0, payload));
    }
    throws(() => createBpubTemplate([coin], a.address, 101, 0, payload));
    for (const value of [0, 329, -1, 330.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      throws(() => createBpubTemplate([coin], a.address, 3, 0, payload, value));
    }
    throws(() => createBpubTemplate([coin], a.address, 3, 0, payload, coin.value));
    const minimum = createBpubTemplate([coin], a.address, 100, 0, payload, 330);
    if (
      Number(minimum.funding.outputs.at(-2)!.amount) !== 330 ||
      minimum.fundingChange !== t.fundingChange + 9670 ||
      minimum.fundingFee !== t.fundingFee || minimum.revealFee !== t.revealFee
    ) {
      throw new Error("Ownership amount should change the reserve and change, not the fees");
    }
  } finally {
    keys.destroy();
  }
});
Deno.test("BPUB rejects oversized, empty, unsupported and mismatched pictures", () => {
  validateBpubImage(image, "image/gif", "a.gif");
  throws(() => validateBpubImage(new Uint8Array(131073), "image/gif", "a.gif"));
  throws(() => validateBpubImage(new Uint8Array(), "image/gif", "a.gif"));
  throws(() => validateBpubImage(image, "image/png", "a.png"));
  throws(() => validateBpubImage(image, "image/gif", "../a.gif"));
  throws(() => validateBpubImage(image, "image/svg+xml", "a.svg"));
});

Deno.test("BPUB maximum-size incompressible picture fits the reviewed relay limits", () => {
  const keys = keychain();
  try {
    // Deterministic pseudo-random fixture, not wallet entropy.
    const data = new Uint8Array(128 * 1024);
    let seed = 1;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = seed & 255;
    }
    data.set(new TextEncoder().encode("GIF89a"));
    const a = keys.derive(0, 0);
    const payload = makeBpubPayload(data, "max.gif", "image/gif", keys, 0);
    const template = createBpubTemplate(
      [{
        txid: "11".repeat(32),
        vout: 0,
        value: 20_000_000,
        path: a.path,
        scriptPubKey: a.scriptPubKey,
      }],
      a.address,
      100,
      0,
      payload,
    );
    if (
      payload.scripts.length < 300 || payload.scripts.length > 310 ||
      template.revealVsize > 100000 || template.fundingVsize > 100000
    ) {
      throw new Error("Unexpected maximum-size transaction limits");
    }
    signBpub(template, keys, 0);
  } finally {
    keys.destroy();
  }
});
