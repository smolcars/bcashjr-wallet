import { base64 } from "@scure/base";
import { RawTx } from "@scure/btc-signer";
import { authorizeSpend } from "./coin_policy.ts";
import { selectCoins, toSpendableCoin } from "./coin_selection.ts";
import { fromHex, toHex } from "./bytes.ts";
import { BPUB_MAX_FILE_BYTES, BPUB_OWNER_VALUE } from "./bpub_limits.ts";
import { assertBpubState } from "./bpub_state.ts";
import {
  type BpubTemplate,
  createBpubTemplate,
  makeBpubPayload,
  signBpub,
  validateBpubImage,
} from "./bpub_transaction.ts";
import { feeNeedsExplicitConfirmation, serializeStripped } from "./transaction.ts";
import type { SpendWorkflowContext } from "./spend_workflow.ts";
import type {
  BpubPreview,
  BpubPreviewRequest,
  BpubPublication,
  TransactionIntent,
  WalletPublicState,
} from "./types.ts";
import type { EsploraClient } from "./esplora.ts";
import { refreshSelectedUtxos } from "./wallet_sync.ts";

interface BpubContext extends SpendWorkflowContext {
  commit(mutator: (draft: WalletPublicState) => void): Promise<void>;
  rebroadcastIntent(id: string): Promise<unknown>;
}
interface StoredPreview {
  preview: BpubPreview;
  template: BpubTemplate;
  keyIndex: number;
  sharedOutpoints: string[];
  backendUrls: string;
}
const backendUrls = (state: WalletPublicState) =>
  JSON.stringify([state.settings.blakeApiUrl, state.settings.btcApiUrl]);

/** One reviewed publication pair. No timers, repeats, or background broadcasting. */
export class BpubWorkflow {
  #previews = new Map<string, StoredPreview>();
  constructor(private readonly context: BpubContext) {}
  clear(): void {
    this.#previews.clear();
  }
  purgeExpired(): void {
    for (const [id, stored] of this.#previews) {
      if (Date.parse(stored.preview.expiresAt) <= this.context.now()) this.#previews.delete(id);
    }
  }
  cancel(id: string): void {
    this.#previews.delete(id);
  }
  async preview(request: BpubPreviewRequest): Promise<BpubPreview> {
    this.purgeExpired();
    const keychain = this.context.requireKeychain();
    const state = this.context.state();
    if (!state.recoveryScanComplete) throw new Error("Finish wallet recovery before publishing");
    if (
      !request || typeof request.dataBase64 !== "string" ||
      request.dataBase64.length > 4 * Math.ceil(BPUB_MAX_FILE_BYTES / 3) ||
      typeof request.filename !== "string" || typeof request.mime !== "string"
    ) throw new Error("Invalid BPUB picture request");
    const data = base64.decode(request.dataBase64);
    validateBpubImage(data, request.mime, request.filename);
    const selected = selectCoins(state, request.outpoints);
    const authorization = authorizeSpend(
      selected,
      "blake",
      state.sharedProvenance,
      state.intents,
      state.settings,
    );
    const change = state.addresses.find((a) =>
      a.branch === 0 && a.index === state.nextReceiveIndex - 1
    );
    const tip = state.tips.blake;
    if (!change || !tip) throw new Error("Sync BLAKE before publishing");
    let feeRate = request.feeRate ?? state.settings.blakeFeeRate;
    if (feeRate === undefined) {
      try {
        feeRate = (await this.context.clients().blake.recommendedFees()).fastestFee;
      } catch {
        feeRate = 1;
      }
    }
    const keyIndex = state.nextPublicationIndex;
    const ownerValue = request.ownerValue ?? BPUB_OWNER_VALUE;
    const payload = makeBpubPayload(data, request.filename, request.mime, keychain, keyIndex);
    const template = createBpubTemplate(
      selected.map(toSpendableCoin),
      change.address,
      feeRate,
      tip.height,
      payload,
      ownerValue,
    );
    const inputValue = selected.reduce((n, c) => n + c.value, 0);
    const preview: BpubPreview = {
      id: crypto.randomUUID(),
      expiresAt: new Date(this.context.now() + 300_000).toISOString(),
      bpubId: payload.id,
      filename: request.filename,
      mime: request.mime,
      size: data.length,
      outpoints: template.coins.map((c) => `${c.txid}:${c.vout}`),
      inputValue,
      feeRate,
      fundingFee: template.fundingFee,
      revealFee: template.revealFee,
      fundingVsize: template.fundingVsize,
      revealVsize: template.revealVsize,
      changeAddress: change.address,
      fundingChange: template.fundingChange,
      revealReturn: template.revealReturn,
      ownerValue,
      dataValue: template.dataValue,
      dataOutputCount: payload.scripts.length,
      highFee: feeNeedsExplicitConfirmation(
        inputValue,
        template.fundingFee + template.revealFee,
        feeRate,
      ),
    };
    // Keep only one preview: large picture/script buffers cannot accumulate through RPC.
    this.clear();
    this.#previews.set(preview.id, {
      preview,
      template,
      keyIndex,
      sharedOutpoints: authorization.splitOutpoints,
      backendUrls: backendUrls(state),
    });
    return structuredClone(preview);
  }
  async confirm(id: string, acceptHighFee: boolean): Promise<void> {
    const stored = this.#previews.get(id);
    if (!stored || Date.parse(stored.preview.expiresAt) <= this.context.now()) {
      throw new Error("BPUB preview expired; review again");
    }
    if (stored.preview.highFee && !acceptHighFee) {
      throw new Error("Confirm the high publication fee");
    }
    this.#previews.delete(id);
    const keychain = this.context.requireKeychain();
    const clients = this.context.clients();
    const [blakeTip, btcTip] = await Promise.all([
      this.context.verifiedTip("blake", clients.blake),
      this.context.verifiedTip("btc", clients.btc),
    ]);
    let state = this.context.state();
    state.tips.blake = blakeTip;
    state.tips.btc = btcTip;
    await refreshSelectedUtxos(
      state,
      selectCoins(state, stored.preview.outpoints),
      clients,
      blakeTip.height,
      btcTip.height,
    );
    const errors: string[] = [];
    await this.context.refreshIntentStatuses(
      clients,
      { blake: blakeTip.height, btc: btcTip.height },
      errors,
      new Set(stored.preview.outpoints),
    );
    await this.context.saveWorkingState();
    state = this.context.state();
    if (errors.length) throw new Error(`Unable to verify publication inputs: ${errors.join("; ")}`);
    if (
      !state.recoveryScanComplete || backendUrls(state) !== stored.backendUrls ||
      state.nextPublicationIndex !== stored.keyIndex ||
      blakeTip.height < stored.template.funding.lockTime
    ) {
      throw new Error("Wallet state changed; review this publication again");
    }
    const selected = selectCoins(state, stored.preview.outpoints);
    const authorization = authorizeSpend(
      selected,
      "blake",
      state.sharedProvenance,
      state.intents,
      state.settings,
    );
    if (
      JSON.stringify([...authorization.splitOutpoints].sort()) !==
        JSON.stringify([...stored.sharedOutpoints].sort())
    ) {
      throw new Error("Split state changed; review this publication again");
    }
    const rebuilt = createBpubTemplate(
      selected.map(toSpendableCoin),
      stored.preview.changeAddress,
      stored.preview.feeRate,
      stored.template.funding.lockTime,
      stored.template.payload,
      stored.preview.ownerValue,
    );
    if (
      toHex(serializeStripped(rebuilt.funding)) !==
        toHex(serializeStripped(stored.template.funding)) ||
      toHex(serializeStripped(rebuilt.reveal)) !== toHex(serializeStripped(stored.template.reveal))
    ) {
      throw new Error("Publication amounts changed; review again");
    }
    const signed = signBpub(rebuilt, keychain, stored.keyIndex);
    const createdAt = new Date(this.context.now()).toISOString();
    const funding: TransactionIntent = {
      id: crypto.randomUUID(),
      txid: signed.funding.txid,
      rawTx: signed.funding.rawTx,
      createdAt,
      phase: "prepared",
      chain: "blake",
      kind: "blake-unified",
      inputOutpoints: stored.preview.outpoints,
      sharedOutpoints: authorization.splitOutpoints,
      parentReplayIntentIds: state.intents.filter((i) =>
        i.kind === "blake-replay" && i.phase !== "abandoned" &&
        i.walletOutpoints.some((o) => stored.preview.outpoints.includes(o))
      ).map((i) => i.id),
    };
    const reveal: TransactionIntent = {
      id: crypto.randomUUID(),
      txid: signed.reveal.txid,
      rawTx: signed.reveal.rawTx,
      createdAt,
      phase: "prepared",
      chain: "blake",
      kind: "blake-bpub-reveal",
      fundingIntentId: funding.id,
      inputOutpoints: rebuilt.payload.scripts.map((_, index) => `${funding.txid}:${index}`),
    };
    const publication: BpubPublication = {
      id,
      keyIndex: stored.keyIndex,
      preview: stored.preview,
      fundingIntentId: funding.id,
      revealIntentId: reveal.id,
      witnessScripts: rebuilt.payload.scripts.map(toHex),
      ownerScript: toHex(rebuilt.payload.ownerScript),
      dataUnspent: null,
      ownerUnspent: null,
    };
    await this.context.commit((draft) => {
      draft.nextPublicationIndex++;
      draft.intents.push(funding, reveal);
      draft.publications.push(publication);
      for (const o of funding.sharedOutpoints) {
        draft.sharedProvenance[o] ??= { firstObservedAt: createdAt };
      }
    });
    await this.resume(id);
  }
  async resume(id: string): Promise<void> {
    this.context.requireKeychain();
    const state = this.context.state();
    assertBpubState(state);
    const publication = state.publications.find((p) => p.id === id);
    if (!publication) throw new Error("Publication not found");
    if (
      state.intents.some((i) => i.id === publication.fundingIntentId && i.phase === "abandoned")
    ) {
      throw new Error("Publication funding was superseded and cannot be resumed");
    }
    try {
      // Reuses the existing funding intent, including any replay-parent protections.
      await this.context.rebroadcastIntent(publication.fundingIntentId);
      const clients = this.context.clients();
      const tip = await this.context.verifiedTip("blake", clients.blake);
      const errors: string[] = [];
      const fresh = this.context.state();
      const funding = fresh.intents.find((i) => i.id === publication.fundingIntentId)!;
      await this.context.refreshIntentStatuses(
        clients,
        { blake: tip.height },
        errors,
        new Set([
          ...(funding.kind === "blake-unified" ? funding.inputOutpoints : []),
          ...publication.witnessScripts.map((_, index) => `${funding.txid}:${index}`),
        ]),
      );
      await this.context.saveWorkingState();
      if (errors.length) throw new Error(errors.join("; "));
      const updated = this.context.state();
      const parent = updated.intents.find((i) => i.id === publication.fundingIntentId)!;
      const child = updated.intents.find((i) => i.id === publication.revealIntentId)!;
      if (parent.phase !== "seen" && parent.phase !== "confirmed") {
        throw new Error("Funding not yet observed on BLAKE; sync and resume later");
      }
      if (child.phase !== "seen" && child.phase !== "confirmed") {
        const outputs = await clients.blake.transactionOutspends(parent.txid);
        if (
          outputs.length !== publication.witnessScripts.length + 2 ||
          outputs.slice(0, publication.witnessScripts.length).some((o) => o.spent)
        ) {
          throw new Error("Publication outputs are unavailable; sync before resuming");
        }
        await this.context.transitionIntent(child.id, {
          type: "broadcast-started",
          at: new Date(this.context.now()).toISOString(),
        });
        await this.context.broadcastIntent(child.id, clients.blake);
      }
      await this.refreshObservations(clients.blake);
      await this.context.saveWorkingState();
    } catch (error) {
      await this.context.commit((draft) => {
        draft.publications.find((p) => p.id === id)!.lastError = error instanceof Error
          ? error.message
          : String(error);
      });
      throw error;
    }
  }
  /** Read only: called after intent reconciliation during manual Sync. */
  async refreshObservations(client: EsploraClient): Promise<void> {
    for (const p of this.context.state().publications) {
      const funding = this.context.state().intents.find((i) => i.id === p.fundingIntentId)!;
      const reveal = this.context.state().intents.find((i) => i.id === p.revealIntentId)!;
      if (funding.phase === "confirmed" && reveal.phase === "confirmed") {
        // The reveal spends every data output. Stop polling special outputs once publication is
        // complete; any earlier ownership observation would otherwise look like a live balance.
        p.dataUnspent = null;
        p.ownerUnspent = null;
        p.checkedAt = undefined;
        p.lastError = undefined;
        continue;
      }
      if (funding.phase !== "confirmed" && funding.phase !== "seen") {
        p.dataUnspent = null;
        p.ownerUnspent = null;
        continue;
      }
      try {
        const outputs = await client.transactionOutspends(funding.txid);
        const count = p.witnessScripts.length;
        if (outputs.length !== count + 2) throw new Error("Incomplete BPUB output observations");
        // Values are pinned in the signed funding transaction, not supplied by the backend.
        const tx = RawTx.decode(fromHex(funding.rawTx));
        p.dataUnspent = outputs.slice(0, count).reduce(
          (sum, o, index) => sum + (o.spent ? 0 : Number(tx.outputs[index].amount)),
          0,
        );
        p.ownerUnspent = outputs[count].spent ? 0 : Number(tx.outputs[count].amount);
        p.checkedAt = new Date(this.context.now()).toISOString();
        p.lastError = undefined;
      } catch (error) {
        p.dataUnspent = null;
        p.ownerUnspent = null;
        p.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}
