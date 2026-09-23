import { authorizeSpend, deriveCoinPolicy } from "./coin_policy.ts";
import { selectCoins, toSpendableCoin } from "./coin_selection.ts";
import type { EsploraClient } from "./esplora.ts";
import type { Bip86Keychain } from "./keys.ts";
import type { IntentEvent } from "./intent_state.ts";
import {
  createSweepTemplate,
  feeNeedsExplicitConfirmation,
  signBtcSweep,
  signUnifiedSweep,
  type SweepMode,
  type SweepTemplate,
} from "./transaction.ts";
import type {
  BroadcastResult,
  ChainId,
  ChainTip,
  SpendPreview,
  SpendPreviewRequest,
  SpendPurpose,
  TransactionIntent,
  WalletPublicState,
} from "./types.ts";
import {
  refreshFundingProvenance,
  refreshSelectedUtxos,
  type WalletClients,
} from "./wallet_sync.ts";

const PREVIEW_LIFETIME_MS = 5 * 60 * 1000;

interface StoredSpendPreview {
  public: SpendPreview;
  template: SweepTemplate;
}

export interface SpendWorkflowContext {
  state(): WalletPublicState;
  requireKeychain(): Bip86Keychain;
  clients(): WalletClients;
  verifiedTip(chain: ChainId, client: EsploraClient): Promise<ChainTip>;
  refreshIntentStatuses(
    clients: WalletClients,
    tipHeights: Partial<Record<ChainId, number>>,
    errors: string[],
    relevantOutpoints?: Set<string>,
  ): Promise<void>;
  saveWorkingState(): Promise<void>;
  storePreparedIntent(intent: TransactionIntent): Promise<void>;
  transitionIntent(intentId: string, event: IntentEvent): Promise<void>;
  broadcastIntent(intentId: string, client: EsploraClient): Promise<void>;
  now(): number;
}

/** Owns ephemeral spend previews and the preview-to-broadcast safety checks. */
export class SpendWorkflow {
  #previews = new Map<string, StoredSpendPreview>();

  constructor(private readonly context: SpendWorkflowContext) {}

  clear(): void {
    this.#previews.clear();
  }

  purgeExpired(): void {
    const now = this.context.now();
    for (const [id, preview] of this.#previews) {
      if (now >= Date.parse(preview.public.expiresAt)) this.#previews.delete(id);
    }
  }

  async preview(request: SpendPreviewRequest): Promise<SpendPreview> {
    this.purgeExpired();
    this.context.requireKeychain();
    if (!request || (request.chain !== "blake" && request.chain !== "btc")) {
      throw new Error("Choose the chain to spend");
    }
    if (request.purpose !== "send" && request.purpose !== "split") {
      throw new Error("Choose a valid spend purpose");
    }
    if (request.purpose === "split" && request.chain !== "blake") {
      throw new Error("Splitting spends only the BLAKE side with SIGHASH_UNIFIED");
    }
    if (typeof request.destination !== "string" || request.destination.length > 128) {
      throw new Error("A destination address is required");
    }
    const state = this.context.state();
    const selected = selectCoins(state, request.outpoints);
    const authorization = authorizeSpend(
      selected,
      request.chain,
      state.sharedProvenance,
      state.intents,
      state.settings,
    );
    const purpose: SpendPurpose = authorization.splitInputCount > 0 ? "split" : "send";
    const clients = this.context.clients();
    const client = clients[request.chain];
    const configuredFeeRate = request.chain === "btc"
      ? state.settings.btcFeeRate
      : state.settings.blakeFeeRate;
    let feeRate = request.feeRate ?? configuredFeeRate;
    if (feeRate === undefined) {
      try {
        feeRate = (await client.recommendedFees()).fastestFee;
      } catch {
        feeRate = 1;
      }
    }
    const lockTime = state.tips[request.chain]?.height;
    if (lockTime === undefined) {
      throw new Error(`Sync the ${request.chain.toUpperCase()} chain before creating a spend`);
    }
    const mode: SweepMode = request.chain === "btc" ? "btc-standard" : "blake-unified";
    const template = createSweepTemplate(
      selected.map(toSpendableCoin),
      request.destination.trim(),
      feeRate,
      lockTime,
      mode,
    );
    const created = this.context.now();
    const publicPreview: SpendPreview = {
      id: crypto.randomUUID(),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + PREVIEW_LIFETIME_MS).toISOString(),
      chain: request.chain,
      purpose,
      splitInputCount: authorization.splitInputCount,
      splitOutpoints: [...authorization.splitOutpoints],
      outpoints: template.coins.map((coin) => `${coin.txid}:${coin.vout}`),
      destination: template.destination,
      inputValue: template.inputValue,
      outputValue: template.outputValue,
      fee: template.fee,
      feeRate: template.feeRate,
      vsize: template.vsize,
      lockTime: template.lockTime,
      sighashType: request.chain === "btc" ? 0x00 : 0x21,
      highFee: feeNeedsExplicitConfirmation(
        template.inputValue,
        template.fee,
        template.feeRate,
      ),
      risks: structuredClone(authorization.risks),
      replayProtectionSplitIntentIds: [...authorization.replayProtectionSplitIntentIds],
    };
    this.#previews.set(publicPreview.id, { public: publicPreview, template });
    return structuredClone(publicPreview);
  }

  cancel(previewId: string): void {
    this.#previews.delete(previewId);
  }

  async confirm(
    previewId: string,
    acceptHighFee: boolean,
    acceptReplayRisk: boolean,
  ): Promise<BroadcastResult> {
    const stored = this.#previews.get(previewId);
    if (!stored) throw new Error("Spend preview is missing or was already used");
    if (this.context.now() >= Date.parse(stored.public.expiresAt)) {
      this.#previews.delete(previewId);
      throw new Error("Spend preview expired");
    }
    if (stored.public.highFee && !acceptHighFee) {
      throw new Error("This high fee requires explicit confirmation");
    }
    if (stored.public.risks.length > 0 && !acceptReplayRisk) {
      throw new Error("The Bitcoin replay risk requires explicit confirmation");
    }
    this.#previews.delete(previewId);
    const { chain, purpose } = stored.public;
    const keychain = this.context.requireKeychain();
    const clients = this.context.clients();
    const [blakeTip, btcTip] = await Promise.all([
      this.context.verifiedTip("blake", clients.blake),
      this.context.verifiedTip("btc", clients.btc),
    ]);
    let state = this.context.state();
    state.tips.blake = blakeTip;
    state.tips.btc = btcTip;
    const refreshedTip = chain === "blake" ? blakeTip : btcTip;
    if (refreshedTip.height < stored.public.lockTime) {
      await this.context.saveWorkingState();
      throw new Error(
        `${chain.toUpperCase()} chain tip moved below this spend's locktime; review the spend again`,
      );
    }
    let selected = selectCoins(state, stored.public.outpoints);
    await refreshSelectedUtxos(state, selected, clients, blakeTip.height, btcTip.height);
    if (chain === "btc") {
      await refreshFundingProvenance(state, selected, clients.blake);
    }
    const validationErrors: string[] = [];
    await this.context.refreshIntentStatuses(
      clients,
      { blake: blakeTip.height, btc: btcTip.height },
      validationErrors,
      new Set(stored.public.outpoints),
    );
    await this.context.saveWorkingState();
    state = this.context.state();
    selected = selectCoins(state, stored.public.outpoints);
    if (validationErrors.length > 0) {
      throw new Error(
        `Transaction safety state could not be verified: ${validationErrors.join("; ")}`,
      );
    }
    const authorization = authorizeSpend(
      selected,
      chain,
      state.sharedProvenance,
      state.intents,
      state.settings,
    );
    if (
      JSON.stringify(authorization.splitOutpoints) !==
        JSON.stringify(stored.public.splitOutpoints)
    ) {
      throw new Error("Split state changed during final validation; create a new preview");
    }
    if (!sameRisks(authorization.risks, stored.public.risks)) {
      throw new Error("Transaction risk changed during final validation; create a new preview");
    }
    if (
      JSON.stringify(authorization.replayProtectionSplitIntentIds) !==
        JSON.stringify(stored.public.replayProtectionSplitIntentIds)
    ) {
      throw new Error(
        "Transaction replay protection changed during final validation; create a new preview",
      );
    }
    const rebuilt = createSweepTemplate(
      selected.map(toSpendableCoin),
      stored.public.destination,
      stored.public.feeRate,
      stored.public.lockTime,
      stored.template.mode,
    );
    if (
      rebuilt.fee !== stored.template.fee || rebuilt.outputValue !== stored.template.outputValue ||
      rebuilt.vsize !== stored.template.vsize
    ) {
      throw new Error("Spend changed during final validation; create a new preview");
    }
    const signed = chain === "btc"
      ? signBtcSweep(rebuilt, keychain)
      : signUnifiedSweep(rebuilt, keychain);
    const createdAt = new Date().toISOString();
    const sharedOutpoints = chain === "blake"
      ? selected.filter((coin) =>
        deriveCoinPolicy(
          coin,
          Boolean(state.sharedProvenance[coin.outpoint]),
          state.intents,
          state.settings,
        ).splittable
      ).map((coin) => coin.outpoint)
      : [];
    const selectedOutpoints = selected.map((coin) => coin.outpoint);
    const intent: TransactionIntent = chain === "blake"
      ? {
        id: crypto.randomUUID(),
        kind: "blake-unified",
        chain,
        txid: signed.txid,
        rawTx: signed.rawTx,
        createdAt,
        phase: "prepared",
        inputOutpoints: selectedOutpoints,
        sharedOutpoints,
        parentReplayIntentIds: parentReplayIntentIds(state, selectedOutpoints),
      }
      : {
        id: crypto.randomUUID(),
        kind: "btc-spend",
        chain,
        txid: signed.txid,
        rawTx: signed.rawTx,
        createdAt,
        phase: "prepared",
        inputOutpoints: selectedOutpoints,
        ...(authorization.risks.length > 0
          ? {
            replayRisk: {
              kinds: authorization.risks.map((risk) => risk.kind),
              splitIntentIds: authorization.risks.flatMap((risk) => risk.splitIntentIds),
              acknowledgedAt: createdAt,
            },
          }
          : {}),
        ...(authorization.replayProtectionSplitIntentIds.length > 0
          ? {
            replayProtection: {
              splitIntentIds: authorization.replayProtectionSplitIntentIds,
            },
          }
          : {}),
      };
    await this.context.storePreparedIntent(intent);
    await this.context.transitionIntent(intent.id, { type: "broadcast-started", at: createdAt });
    await this.context.broadcastIntent(intent.id, clients[chain]);
    return { txid: signed.txid, rawTx: signed.rawTx, chain, action: purpose };
  }
}

function parentReplayIntentIds(state: WalletPublicState, outpoints: string[]): string[] {
  const selected = new Set(outpoints);
  return state.intents
    .filter((intent) =>
      intent.kind === "blake-replay" && intent.phase === "confirmed" &&
      intent.walletOutpoints.some((outpoint) => selected.has(outpoint))
    )
    .map((intent) => intent.id)
    .sort();
}

function sameRisks(left: SpendPreview["risks"], right: SpendPreview["risks"]): boolean {
  const normalized = (risks: SpendPreview["risks"]) =>
    risks.map((risk) => ({
      kind: risk.kind,
      splitIntentIds: [...new Set(risk.splitIntentIds)].sort(),
    })).sort((a, b) => a.kind.localeCompare(b.kind));
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
