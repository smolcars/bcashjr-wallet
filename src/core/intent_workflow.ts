import { selectCoins } from "./coin_selection.ts";
import { publicationForIntent } from "./bpub_state.ts";
import type { EsploraClient, EsploraTxStatus } from "./esplora.ts";
import type { Bip86Keychain } from "./keys.ts";
import { linkReplayDependencies } from "./intent_reconciler.ts";
import {
  btcIntentReliesOnSplit,
  type IntentEvent,
  intentOutpoints,
  reduceIntent,
  summarizeIntent,
} from "./intent_state.ts";
import type {
  BroadcastResult,
  ChainCoinObservation,
  ChainId,
  ChainTip,
  TransactionIntent,
  WalletPublicState,
} from "./types.ts";
import { refreshSelectedUtxos, type WalletClients } from "./wallet_sync.ts";

const INTENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export interface IntentWorkflowContext {
  state(): WalletPublicState;
  requireKeychain(): Bip86Keychain;
  clients(): WalletClients;
  verifiedTip(chain: ChainId, client: EsploraClient): Promise<ChainTip>;
  refreshOneIntent(
    intentId: string,
    client: EsploraClient,
    tipHeight: number,
  ): Promise<EsploraTxStatus | null>;
  saveWorkingState(): Promise<void>;
  commit(mutator: (draft: WalletPublicState) => void): Promise<void>;
  transitionIntent(intentId: string, event: IntentEvent): Promise<void>;
}

/** Owns durable intent creation, broadcast, rebroadcast, and abandonment. */
export class IntentWorkflow {
  constructor(private readonly context: IntentWorkflowContext) {}

  async rebroadcast(intentId: string): Promise<BroadcastResult> {
    this.context.requireKeychain();
    const intent = this.#intent(intentId);
    if (intent.kind === "blake-bpub-reveal") {
      throw new Error("Resume this publication from the BPUB screen");
    }
    const clients = this.context.clients();
    const tip = await this.context.verifiedTip(intent.chain, clients[intent.chain]);
    this.context.state().tips[intent.chain] = tip;
    if (intent.kind === "blake-unified") {
      for (const parentIntentId of intent.parentReplayIntentIds) {
        await this.context.refreshOneIntent(parentIntentId, clients.blake, tip.height);
      }
    } else if (intent.kind === "btc-spend" && intent.replayProtection) {
      const blakeTip = await this.context.verifiedTip("blake", clients.blake);
      this.context.state().tips.blake = blakeTip;
      const protectionSplits = intent.replayProtection.splitIntentIds.map((splitIntentId) => {
        const split = this.#intent(splitIntentId);
        if (split.kind !== "blake-unified") {
          throw new Error(`Replay protection ${splitIntentId} is not a BLAKE split`);
        }
        return split;
      });
      const parentIntentIds = new Set(
        protectionSplits.flatMap((split) => split.parentReplayIntentIds),
      );
      for (const parentIntentId of parentIntentIds) {
        await this.context.refreshOneIntent(parentIntentId, clients.blake, blakeTip.height);
      }
      for (const split of protectionSplits) {
        await this.context.refreshOneIntent(split.id, clients.blake, blakeTip.height);
      }
    }
    const status = await this.context.refreshOneIntent(
      intentId,
      clients[intent.chain],
      tip.height,
    );
    await this.context.saveWorkingState();
    const refreshed = this.#intent(intentId);
    if (status) {
      if (refreshed.kind === "blake-replay") {
        await this.rebroadcastProtectionChildren(refreshed.id);
      }
      return intentResult(refreshed);
    }
    const summary = summarizeIntent(refreshed, this.context.state().intents);
    if (!summary.canRebroadcast) {
      throw new Error(
        summary.blockedBy.length > 0
          ? refreshed.kind === "btc-spend"
            ? "Restore confirmed BLAKE split protection before rebroadcasting this Bitcoin transaction"
            : `Rebroadcast parent replay ${summary.blockedBy.join(", ")} before this transaction`
          : `Transaction cannot be rebroadcast while it is ${refreshed.phase}`,
      );
    }
    const startedAt = new Date().toISOString();
    await this.context.commit((draft) => {
      const index = draft.intents.findIndex((candidate) => candidate.id === intentId);
      if (index < 0) throw new Error(`Transaction intent ${intentId} is missing`);
      draft.intents[index] = reduceIntent(draft.intents[index], {
        type: "broadcast-started",
        at: startedAt,
      });
    });
    await this.broadcast(intentId, clients[refreshed.chain]);
    const complete = this.#intent(intentId);
    if (complete.kind === "blake-replay") {
      await this.rebroadcastProtectionChildren(complete.id);
    }
    return intentResult(complete);
  }

  async abandon(intentId: string): Promise<void> {
    this.context.requireKeychain();
    const intent = this.#intent(intentId);
    if (publicationForIntent(this.context.state(), intentId)) {
      throw new Error(
        "A signed BPUB publication cannot be abandoned; resume it from the BPUB screen",
      );
    }
    const clients = this.context.clients();
    const [blakeTip, btcTip] = await Promise.all([
      this.context.verifiedTip("blake", clients.blake),
      this.context.verifiedTip("btc", clients.btc),
    ]);
    let state = this.context.state();
    state.tips.blake = blakeTip;
    state.tips.btc = btcTip;
    const intentOutpointSet = new Set(intentOutpoints(intent));
    const coins = intent.kind === "blake-replay"
      ? state.coins.filter((coin) => intentOutpointSet.has(coin.outpoint))
      : selectCoins(state, [...intentOutpointSet]);
    if (coins.length > 0) {
      await refreshSelectedUtxos(state, coins, clients, blakeTip.height, btcTip.height);
    }
    await this.context.refreshOneIntent(
      intentId,
      clients[intent.chain],
      intent.chain === "blake" ? blakeTip.height : btcTip.height,
    );
    await this.context.saveWorkingState();
    state = this.context.state();
    const refreshed = this.#intent(intentId);
    if (refreshed.phase !== "prepared" && refreshed.phase !== "recoverable") {
      throw new Error(`Transaction cannot be abandoned while it is ${refreshed.phase}`);
    }
    if (
      refreshed.kind === "blake-replay" &&
      refreshed.walletOutpoints.some((outpoint) => state.sharedProvenance[outpoint])
    ) {
      throw new Error(
        "A previously observed BLAKE replay cannot be abandoned safely; rebroadcast it instead",
      );
    }
    if (
      refreshed.kind === "blake-unified" &&
      state.intents.some((candidate) => btcIntentReliesOnSplit(candidate, refreshed.id))
    ) {
      throw new Error(
        "This split protects a Bitcoin transaction from replay on BTC-BLAKE and cannot be abandoned",
      );
    }
    await this.context.transitionIntent(intentId, {
      type: "abandoned",
      at: new Date().toISOString(),
    });
  }

  async rebroadcastProtectionChildren(parentIntentId: string): Promise<void> {
    const state = this.context.state();
    const childIntentIds = state.intents
      .filter((intent) =>
        intent.kind === "blake-unified" &&
        intent.parentReplayIntentIds.includes(parentIntentId) &&
        state.intents.some((candidate) => btcIntentReliesOnSplit(candidate, intent.id))
      )
      .map((intent) => intent.id);
    const failures: string[] = [];
    for (const childIntentId of childIntentIds) {
      const child = this.#intent(childIntentId);
      if (!summarizeIntent(child, this.context.state().intents).canRebroadcast) continue;
      try {
        await this.rebroadcast(childIntentId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${child.txid}: ${detail}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Replay parent was accepted, but ${failures.length} protective split${
          failures.length === 1 ? "" : "s"
        } could not be rebroadcast: ${failures.join("; ")}`,
      );
    }
  }

  async storePrepared(intent: TransactionIntent): Promise<void> {
    await this.context.commit((draft) => {
      if (draft.intents.some((candidate) => candidate.id === intent.id)) {
        throw new Error(`Transaction intent ${intent.id} already exists`);
      }
      draft.intents.push(structuredClone(intent));
      if (intent.kind === "blake-replay") {
        linkReplayDependencies(draft, intent);
      } else if (intent.kind === "blake-unified") {
        for (const outpoint of intent.sharedOutpoints) {
          draft.sharedProvenance[outpoint] ??= { firstObservedAt: intent.createdAt };
        }
      }
    });
  }

  async broadcast(intentId: string, client: EsploraClient): Promise<void> {
    const intent = this.#intent(intentId);
    let returnedTxid: string;
    try {
      returnedTxid = await client.broadcast(intent.rawTx);
    } catch (error) {
      await this.context.transitionIntent(intentId, {
        type: "broadcast-result",
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (returnedTxid !== intent.txid) {
      const error = `Backend returned unexpected transaction id ${returnedTxid}`;
      await this.context.transitionIntent(intentId, {
        type: "broadcast-result",
        at: new Date().toISOString(),
        error,
      });
      throw new Error(error);
    }
    const observedAt = new Date().toISOString();
    await this.context.commit((draft) => {
      const index = draft.intents.findIndex((candidate) => candidate.id === intentId);
      if (index < 0) throw new Error(`Transaction intent ${intentId} is missing`);
      const current = draft.intents[index];
      draft.intents[index] = reduceIntent(current, {
        type: "broadcast-result",
        at: observedAt,
      });
      if (current.kind === "blake-replay") {
        for (const outpoint of current.walletInputOutpoints) {
          const coin = draft.coins.find((candidate) => candidate.outpoint === outpoint);
          if (!coin) continue;
          coin.blake = {
            ...coin.blake,
            checkedAt: observedAt,
            backendOk: true,
            tx: coin.blake.tx?.present
              ? coin.blake.tx
              : { present: true, confirmed: false, confirmations: 0 },
            unspent: false,
            error: undefined,
          };
        }
        for (const outpoint of current.walletOutpoints) {
          draft.sharedProvenance[outpoint] ??= { firstObservedAt: observedAt };
          const coin = draft.coins.find((candidate) => candidate.outpoint === outpoint);
          if (!coin) continue;
          coin.blake = {
            checkedAt: observedAt,
            backendOk: true,
            tx: { present: true, confirmed: false, confirmations: 0 },
            unspent: true,
          };
        }
        return;
      }
      for (const outpoint of current.inputOutpoints) {
        const coin = draft.coins.find((candidate) => candidate.outpoint === outpoint);
        if (!coin) continue;
        const observation = current.chain === "btc" ? coin.btc : coin.blake;
        const next: ChainCoinObservation = {
          ...observation,
          checkedAt: observedAt,
          backendOk: true,
          unspent: false,
          error: undefined,
        };
        if (current.chain === "btc") coin.btc = next;
        else coin.blake = next;
      }
    });
  }

  #intent(intentId: string): TransactionIntent {
    if (!INTENT_ID.test(intentId)) throw new Error("Invalid transaction intent id");
    const intent = this.context.state().intents.find((candidate) => candidate.id === intentId);
    if (!intent) throw new Error("Transaction intent not found");
    return intent;
  }
}

function intentResult(intent: TransactionIntent): BroadcastResult {
  const action = intent.kind === "blake-replay"
    ? "replay"
    : intent.kind === "blake-unified" && intent.sharedOutpoints.length > 0
    ? "split"
    : "send";
  return {
    txid: intent.txid,
    rawTx: intent.rawTx,
    chain: intent.chain,
    action,
  };
}
