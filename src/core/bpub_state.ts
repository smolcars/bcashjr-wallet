import { RawTx } from "@scure/btc-signer";
import { bpubP2wsh } from "../bpub/mod.ts";
import { equalBytes, fromHex, toHex } from "./bytes.ts";
import { parseDestinationAddress } from "./destination.ts";
import { BPUB_MAX_FILE_BYTES, BPUB_MIN_OWNER_VALUE } from "./bpub_limits.ts";
import type { BpubPublication, BpubPublicationSummary, WalletPublicState } from "./types.ts";

export function publicationForIntent(
  state: WalletPublicState,
  id: string,
): BpubPublication | undefined {
  return state.publications.find((p) => p.fundingIntentId === id || p.revealIntentId === id);
}
export function summarizePublication(
  state: WalletPublicState,
  publication: BpubPublication,
): BpubPublicationSummary {
  const funding = state.intents.find((i) => i.id === publication.fundingIntentId)!;
  const reveal = state.intents.find((i) => i.id === publication.revealIntentId)!;
  return {
    id: publication.id,
    filename: publication.preview.filename,
    size: publication.preview.size,
    bpubId: publication.preview.bpubId,
    fundingTxid: funding.txid,
    revealTxid: reveal.txid,
    fundingPhase: funding.phase,
    revealPhase: reveal.phase,
    totalFee: publication.preview.fundingFee + publication.preview.revealFee,
    dataUnspent: publication.dataUnspent,
    ownerUnspent: publication.ownerUnspent,
    checkedAt: publication.checkedAt,
    lastError: publication.lastError ?? reveal.lastError ?? funding.lastError,
  };
}

/** Publication metadata is durable safety state, not a discardable UTXO cache. */
export function assertBpubState(state: WalletPublicState): void {
  if (
    state.schema !== 2 || !Array.isArray(state.publications) ||
    !Number.isSafeInteger(state.nextPublicationIndex) || state.nextPublicationIndex < 0 ||
    state.nextPublicationIndex > 0x80000000
  ) throw new Error("Invalid BPUB wallet state");
  const ids = new Set<string>();
  const indices = new Set<number>();
  const intentIds = new Set<string>();
  for (const p of state.publications) {
    if (
      !p || !/^[0-9a-f-]{36}$/u.test(p.id) || ids.has(p.id) ||
      !Number.isSafeInteger(p.keyIndex) || p.keyIndex < 0 ||
      p.keyIndex >= state.nextPublicationIndex || indices.has(p.keyIndex)
    ) {
      throw new Error("Invalid BPUB publication identity");
    }
    ids.add(p.id);
    indices.add(p.keyIndex);
    const preview = p.preview;
    if (
      !preview || preview.id !== p.id || !/^[0-9a-f]{64}$/u.test(preview.bpubId) ||
      typeof preview.filename !== "string" || preview.filename.length > 255 || !preview.filename ||
      /[\\/]/u.test(preview.filename) || [...preview.filename].some((c) =>
        c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
      ) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(preview.mime) ||
      !Number.isSafeInteger(preview.size) || preview.size < 1 ||
      preview.size > BPUB_MAX_FILE_BYTES ||
      !Number.isFinite(preview.feeRate) || preview.feeRate <= 0 || preview.feeRate > 100 ||
      !Number.isFinite(Date.parse(preview.expiresAt))
    ) throw new Error("Invalid BPUB review record");
    for (
      const n of [
        preview.inputValue,
        preview.fundingFee,
        preview.revealFee,
        preview.fundingVsize,
        preview.revealVsize,
        preview.fundingChange,
        preview.revealReturn,
        preview.dataValue,
        preview.dataOutputCount,
      ]
    ) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid BPUB amount or size");
    }
    if (
      !Number.isSafeInteger(preview.ownerValue) || preview.ownerValue < BPUB_MIN_OWNER_VALUE ||
      preview.fundingChange < 330 ||
      preview.revealReturn < 330 ||
      preview.inputValue !==
        preview.fundingFee + preview.dataValue + preview.ownerValue + preview.fundingChange ||
      preview.dataValue !== preview.revealFee + preview.revealReturn ||
      preview.fundingFee !== Math.ceil(preview.fundingVsize * preview.feeRate) ||
      preview.revealFee !== Math.ceil(preview.revealVsize * preview.feeRate)
    ) throw new Error("BPUB balance mismatch");
    if (
      !Array.isArray(p.witnessScripts) || p.witnessScripts.length !== preview.dataOutputCount ||
      p.witnessScripts.length > 310 || typeof p.ownerScript !== "string" ||
      !/^20[0-9a-f]{64}7576a914[0-9a-f]{40}88ac$/u.test(p.ownerScript) ||
      p.ownerScript.slice(2, 66) !== preview.bpubId
    ) throw new Error("Invalid BPUB scripts");
    for (const value of [p.dataUnspent, p.ownerUnspent]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(
          "Invalid BPUB observation",
        );
      }
    }
    if (
      (p.checkedAt !== undefined && !Number.isFinite(Date.parse(p.checkedAt))) ||
      (p.lastError !== undefined && typeof p.lastError !== "string")
    ) throw new Error("Invalid BPUB status");
    const funding = state.intents.find((i) => i.id === p.fundingIntentId);
    const reveal = state.intents.find((i) => i.id === p.revealIntentId);
    if (
      !funding || funding.kind !== "blake-unified" || !reveal ||
      reveal.kind !== "blake-bpub-reveal" ||
      reveal.fundingIntentId !== funding.id || intentIds.has(funding.id) ||
      intentIds.has(reveal.id) || reveal.phase === "abandoned"
    ) throw new Error("BPUB intent linkage is invalid");
    intentIds.add(funding.id);
    intentIds.add(reveal.id);
    if (
      JSON.stringify(preview.outpoints) !== JSON.stringify(funding.inputOutpoints)
    ) throw new Error("BPUB selected inputs changed");
    const f = RawTx.decode(fromHex(funding.rawTx));
    const r = RawTx.decode(fromHex(reveal.rawTx));
    const count = p.witnessScripts.length;
    if (
      f.outputs.length !== count + 2 || r.inputs.length !== count || r.outputs.length !== 1 ||
      !f.witnesses || !r.witnesses ||
      f.witnesses.some((w) => w.length !== 1 || w[0].length !== 65 || w[0][64] !== 0x21)
    ) {
      throw new Error("BPUB transaction structure changed");
    }
    let value = 0;
    for (let index = 0; index < count; index++) {
      const script = fromHex(p.witnessScripts[index]);
      if (
        script.length < 71 || script.length > 513 || (script.length - 3) % 34 !== 0 ||
        script[0] !== 0x51 || script.at(-1) !== 0xae ||
        script.at(-2) !== 0x50 + (script.length - 3) / 34 ||
        !equalBytes(f.outputs[index].script, bpubP2wsh(script)) || f.outputs[index].amount < 546n ||
        toHex(r.inputs[index].txid) !== funding.txid || r.inputs[index].index !== index ||
        reveal.inputOutpoints[index] !== `${funding.txid}:${index}`
      ) throw new Error("BPUB data output changed");
      const witness = r.witnesses[index];
      if (
        !witness || witness.length !== 3 || witness[0].length !== 0 ||
        witness[1].length > 73 || witness[1].at(-1) !== 0x21 ||
        !equalBytes(witness[2], script)
      ) throw new Error("BPUB reveal witness changed");
      value += Number(f.outputs[index].amount);
    }
    const change = parseDestinationAddress(preview.changeAddress).script;
    if (
      !state.addresses.some((a) =>
        a.address === preview.changeAddress && a.scriptPubKey === toHex(change)
      ) ||
      !equalBytes(f.outputs[count].script, bpubP2wsh(fromHex(p.ownerScript))) ||
      Number(f.outputs[count].amount) !== preview.ownerValue || value !== preview.dataValue ||
      !equalBytes(f.outputs[count + 1].script, change) ||
      !equalBytes(r.outputs[0].script, change) ||
      Number(f.outputs[count + 1].amount) !== preview.fundingChange ||
      Number(r.outputs[0].amount) !== preview.revealReturn
    ) {
      throw new Error("BPUB owner or return output changed");
    }
  }
  for (const i of state.intents) {
    if (i.kind === "blake-bpub-reveal" && !intentIds.has(i.id)) {
      throw new Error("Orphan BPUB reveal intent");
    }
  }
}
