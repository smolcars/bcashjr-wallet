import { Transaction } from "@scure/btc-signer";
import { fromHex, toHex } from "./bytes.ts";
import { assertBpubState } from "./bpub_state.ts";
import type {
  ChainCoinObservation,
  ChainTxStatus,
  IntentObservation,
  IntentSummary,
  TransactionIntent,
  WalletPublicState,
} from "./types.ts";

const TXID = /^[0-9a-f]{64}$/u;
const OUTPOINT = /^[0-9a-f]{64}:(?:0|[1-9]\d*)$/u;
const INTENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export type IntentEvent =
  | { type: "broadcast-started"; at: string }
  | { type: "broadcast-result"; at: string; error?: string }
  | {
    type: "observed";
    observation: IntentObservation;
    recoverable: boolean;
    requiredConfirmations: number;
  }
  | { type: "abandoned"; at: string }
  | { type: "superseded"; at: string };

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertChainStatus(status: ChainTxStatus, label: string): void {
  if (
    typeof status.present !== "boolean" || typeof status.confirmed !== "boolean" ||
    !Number.isSafeInteger(status.confirmations) || status.confirmations < 0 ||
    (status.confirmed && !status.present) ||
    ((!status.present || !status.confirmed) && status.confirmations !== 0) ||
    (!status.present && (status.blockHeight !== undefined || status.blockHash !== undefined)) ||
    (status.blockHeight !== undefined &&
      (!Number.isSafeInteger(status.blockHeight) || status.blockHeight < 0)) ||
    (status.blockHash !== undefined && typeof status.blockHash !== "string")
  ) {
    throw new Error(`${label} contains a malformed transaction status`);
  }
}

function assertCoinObservation(observation: ChainCoinObservation, label: string): void {
  if (!validTimestamp(observation.checkedAt) || typeof observation.backendOk !== "boolean") {
    throw new Error(`${label} contains a malformed chain observation`);
  }
  if (!observation.backendOk) {
    if (
      observation.tx !== null || observation.unspent !== null ||
      typeof observation.error !== "string"
    ) throw new Error(`${label} contains an unsafe failed observation`);
    return;
  }
  if (
    !observation.tx || typeof observation.unspent !== "boolean" || observation.error !== undefined
  ) {
    throw new Error(`${label} contains a malformed successful observation`);
  }
  assertChainStatus(observation.tx, label);
  if (observation.unspent && !observation.tx.present) {
    throw new Error(`${label} marks an absent transaction output as unspent`);
  }
}

function assertIntentObservation(observation: IntentObservation, label: string): void {
  if (!validTimestamp(observation.checkedAt) || typeof observation.backendOk !== "boolean") {
    throw new Error(`${label} contains a malformed intent observation`);
  }
  if (!observation.backendOk) {
    if (observation.tx !== null || typeof observation.error !== "string") {
      throw new Error(`${label} contains an unsafe failed intent observation`);
    }
    return;
  }
  if (!observation.tx || observation.error !== undefined) {
    throw new Error(`${label} contains a malformed successful intent observation`);
  }
  assertChainStatus(observation.tx, label);
}

export function intentOutpoints(intent: TransactionIntent): string[] {
  return intent.kind === "blake-replay"
    ? [...new Set([...intent.walletInputOutpoints, ...intent.walletOutpoints])]
    : intent.inputOutpoints;
}

/** The durable broadcast marker means the signed transaction may have reached a peer. */
export function intentMayHaveReachedNetwork(intent: TransactionIntent): boolean {
  return intent.broadcastStartedAt !== undefined;
}

/** Abandonment is local only; exposed transactions must still be watched for reappearance. */
export function intentNeedsReconciliation(intent: TransactionIntent): boolean {
  return intent.phase !== "abandoned" || intentMayHaveReachedNetwork(intent);
}

/** An exposed BTC transaction keeps its split dependency even after local abandonment. */
export function btcIntentReliesOnSplit(
  intent: TransactionIntent,
  splitIntentId: string,
): boolean {
  return intent.kind === "btc-spend" && intentNeedsReconciliation(intent) &&
    intent.replayProtection?.splitIntentIds.includes(splitIntentId) === true;
}

export function intentBlocksOutpoint(intent: TransactionIntent, outpoint: string): boolean {
  return intent.phase !== "confirmed" && intent.phase !== "abandoned" &&
    intentOutpoints(intent).includes(outpoint);
}

export function reduceIntent(
  intent: TransactionIntent,
  event: IntentEvent,
): TransactionIntent {
  const next = structuredClone(intent);
  switch (event.type) {
    case "broadcast-started": {
      if (
        next.phase !== "prepared" && next.phase !== "recoverable" &&
        next.phase !== "broadcast-unknown"
      ) {
        throw new Error(`Cannot broadcast an intent in ${next.phase} state`);
      }
      if (!validTimestamp(event.at)) throw new Error("Invalid broadcast timestamp");
      next.phase = "broadcast-unknown";
      next.broadcastStartedAt ??= event.at;
      next.lastBroadcastAt = event.at;
      next.lastError = undefined;
      next.abandonedAt = undefined;
      return next;
    }
    case "broadcast-result": {
      if (next.phase !== "broadcast-unknown") {
        throw new Error(`Cannot record a broadcast result in ${next.phase} state`);
      }
      if (!validTimestamp(event.at)) throw new Error("Invalid broadcast-result timestamp");
      next.lastBroadcastAt = event.at;
      next.lastError = event.error;
      if (!event.error) next.phase = "seen";
      return next;
    }
    case "observed": {
      const observation = structuredClone(event.observation);
      next.lastObservation = observation;
      next.lastError = observation.backendOk ? undefined : observation.error;
      if (!observation.backendOk) {
        if (next.phase !== "prepared" && next.phase !== "abandoned") {
          next.phase = "broadcast-unknown";
        }
        return next;
      }
      if (observation.tx?.present) {
        next.broadcastStartedAt ??= observation.checkedAt;
        next.phase = observation.tx.confirmed &&
            observation.tx.confirmations >= Math.max(1, event.requiredConfirmations)
          ? "confirmed"
          : "seen";
        next.abandonedAt = undefined;
        return next;
      }
      if (next.phase === "prepared" && !next.broadcastStartedAt) return next;
      if (next.phase === "abandoned") return next;
      next.phase = event.recoverable ? "recoverable" : "broadcast-unknown";
      return next;
    }
    case "abandoned": {
      if (next.phase !== "prepared" && next.phase !== "recoverable") {
        throw new Error(`Cannot abandon an intent in ${next.phase} state`);
      }
      if (!validTimestamp(event.at)) throw new Error("Invalid abandonment timestamp");
      next.phase = "abandoned";
      next.abandonedAt = event.at;
      next.lastError = undefined;
      return next;
    }
    case "superseded": {
      if (!validTimestamp(event.at)) throw new Error("Invalid supersession timestamp");
      next.phase = "abandoned";
      next.abandonedAt = event.at;
      next.lastError = undefined;
      return next;
    }
  }
}

function decodedTransaction(intent: TransactionIntent): Transaction {
  let transaction: Transaction;
  try {
    transaction = Transaction.fromRaw(fromHex(intent.rawTx), {
      allowUnknownVersion: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  } catch {
    throw new Error(`Intent ${intent.txid} contains an invalid raw transaction`);
  }
  if (transaction.id !== intent.txid) {
    throw new Error(`Intent raw transaction does not match ${intent.txid}`);
  }
  return transaction;
}

function assertUniqueOutpoints(label: string, outpoints: unknown, allowEmpty = false): void {
  if (
    !Array.isArray(outpoints) || (!allowEmpty && outpoints.length === 0) ||
    outpoints.some((outpoint) => typeof outpoint !== "string" || !OUTPOINT.test(outpoint)) ||
    new Set(outpoints).size !== outpoints.length
  ) {
    throw new Error(`${label} contains invalid or duplicate outpoints`);
  }
}

export function assertTransactionIntent(intent: TransactionIntent): void {
  if (!INTENT_ID.test(intent.id) || !TXID.test(intent.txid) || !validTimestamp(intent.createdAt)) {
    throw new Error("Transaction intent identity is malformed");
  }
  if (intent.broadcastStartedAt !== undefined && !validTimestamp(intent.broadcastStartedAt)) {
    throw new Error(`Intent ${intent.txid} has an invalid broadcast timestamp`);
  }
  if (intent.lastBroadcastAt !== undefined && !validTimestamp(intent.lastBroadcastAt)) {
    throw new Error(`Intent ${intent.txid} has an invalid broadcast-result timestamp`);
  }
  if (intent.abandonedAt !== undefined && !validTimestamp(intent.abandonedAt)) {
    throw new Error(`Intent ${intent.txid} has an invalid abandonment timestamp`);
  }
  if (
    intent.lastObservation !== undefined &&
    !validTimestamp(intent.lastObservation.checkedAt)
  ) {
    throw new Error(`Intent ${intent.txid} has an invalid observation timestamp`);
  }
  if (intent.lastObservation) {
    assertIntentObservation(intent.lastObservation, `Intent ${intent.txid}`);
  }
  if (intent.phase === "abandoned" && intent.abandonedAt === undefined) {
    throw new Error(`Abandoned intent ${intent.txid} is missing its abandonment timestamp`);
  }
  if (intent.phase !== "abandoned" && intent.abandonedAt !== undefined) {
    throw new Error(`Active intent ${intent.txid} has an abandonment timestamp`);
  }
  if (intent.phase === "prepared" && intent.broadcastStartedAt !== undefined) {
    throw new Error(`Prepared intent ${intent.txid} already has a broadcast timestamp`);
  }
  if (
    intent.phase !== "prepared" && intent.phase !== "abandoned" &&
    intent.broadcastStartedAt === undefined
  ) {
    throw new Error(`Intent ${intent.txid} is missing its broadcast timestamp`);
  }
  const transaction = decodedTransaction(intent);
  const rawInputs = Array.from({ length: transaction.inputsLength }, (_, index) => {
    const input = transaction.getInput(index);
    const txid = typeof input.txid === "string" ? input.txid : input.txid ? toHex(input.txid) : "";
    return `${txid}:${input.index}`;
  }).sort();
  if (intent.kind === "blake-replay") {
    if (intent.chain !== "blake") throw new Error("Replay intent is assigned to the wrong chain");
    assertUniqueOutpoints("Replay wallet-input set", intent.walletInputOutpoints, true);
    assertUniqueOutpoints("Replay wallet-output set", intent.walletOutpoints);
    if (intent.walletInputOutpoints.some((outpoint) => !rawInputs.includes(outpoint))) {
      throw new Error(
        `Replay intent ${intent.txid} references an input absent from its transaction`,
      );
    }
    for (const outpoint of intent.walletOutpoints) {
      const [txid, voutText] = outpoint.split(":");
      if (txid !== intent.txid || Number(voutText) >= transaction.outputsLength) {
        throw new Error(`Replay intent ${intent.txid} references an impossible wallet output`);
      }
    }
    return;
  }

  assertUniqueOutpoints("Spend intent", intent.inputOutpoints);
  const metadataInputs = [...intent.inputOutpoints].sort();
  if (
    rawInputs.length !== intent.inputOutpoints.length ||
    rawInputs.some((outpoint, index) => outpoint !== metadataInputs[index])
  ) {
    throw new Error(`Intent ${intent.txid} input metadata does not match its raw transaction`);
  }
  if (intent.kind === "blake-bpub-reveal") {
    if (intent.chain !== "blake" || !INTENT_ID.test(intent.fundingIntentId)) {
      throw new Error("Invalid BPUB reveal intent");
    }
    return;
  }
  if (intent.kind === "blake-unified") {
    if (intent.chain !== "blake") {
      throw new Error("Unified spend intent is assigned to the wrong chain");
    }
    assertUniqueOutpoints("Unified shared-input set", intent.sharedOutpoints, true);
    if (intent.sharedOutpoints.some((outpoint) => !intent.inputOutpoints.includes(outpoint))) {
      throw new Error(`Split intent ${intent.txid} has invalid shared-input metadata`);
    }
    if (
      new Set(intent.parentReplayIntentIds).size !== intent.parentReplayIntentIds.length ||
      intent.parentReplayIntentIds.some((id) => !INTENT_ID.test(id))
    ) {
      throw new Error(`Split intent ${intent.txid} has invalid replay dependencies`);
    }
    return;
  }

  if (intent.chain !== "btc") throw new Error("BTC spend intent is assigned to the wrong chain");
  if (intent.replayProtection) {
    if (
      intent.replayProtection.splitIntentIds.length === 0 ||
      new Set(intent.replayProtection.splitIntentIds).size !==
        intent.replayProtection.splitIntentIds.length ||
      intent.replayProtection.splitIntentIds.some((id) => !INTENT_ID.test(id))
    ) {
      throw new Error(`BTC intent ${intent.txid} has invalid replay-protection metadata`);
    }
  }
  if (intent.replayRisk) {
    if (
      !validTimestamp(intent.replayRisk.acknowledgedAt) ||
      intent.replayRisk.kinds.length === 0 ||
      new Set(intent.replayRisk.kinds).size !== intent.replayRisk.kinds.length ||
      intent.replayRisk.kinds.some((kind) =>
        kind !== "shared-coin-replay" && kind !== "possible-funding-replay"
      ) ||
      new Set(intent.replayRisk.splitIntentIds).size !==
        intent.replayRisk.splitIntentIds.length ||
      intent.replayRisk.splitIntentIds.some((id) => !INTENT_ID.test(id))
    ) {
      throw new Error(`BTC intent ${intent.txid} has invalid replay-risk acknowledgement`);
    }
  }
}

function parentReplayAccepted(intent: TransactionIntent | undefined): boolean {
  return intent?.kind === "blake-replay" &&
    (intent.phase === "seen" || intent.phase === "confirmed");
}

export function splitProvidesConfirmedProtection(
  intent: TransactionIntent | undefined,
  allIntents: TransactionIntent[],
): boolean {
  return intent?.kind === "blake-unified" && intent.phase === "confirmed" &&
    intent.parentReplayIntentIds.every((parentId) =>
      allIntents.some((candidate) =>
        candidate.id === parentId &&
        candidate.kind === "blake-replay" && candidate.phase === "confirmed"
      )
    );
}

function allowedSplitBtcPair(
  split: Extract<TransactionIntent, { kind: "blake-unified" }>,
  btc: Extract<TransactionIntent, { kind: "btc-spend" }>,
  outpoint: string,
): boolean {
  return Boolean(btc.replayRisk || btc.replayProtection?.splitIntentIds.length) &&
    split.inputOutpoints.includes(outpoint) && btc.inputOutpoints.includes(outpoint);
}

function allowedActivePair(
  left: TransactionIntent,
  right: TransactionIntent,
  outpoint: string,
  allIntents: TransactionIntent[],
) {
  const split = left.kind === "blake-unified"
    ? left
    : right.kind === "blake-unified"
    ? right
    : undefined;
  const btc = left.kind === "btc-spend" ? left : right.kind === "btc-spend" ? right : undefined;
  if (split && btc && allowedSplitBtcPair(split, btc, outpoint)) return true;

  const replay = left.kind === "blake-replay"
    ? left
    : right.kind === "blake-replay"
    ? right
    : undefined;
  if (
    split && replay && split.parentReplayIntentIds.includes(replay.id) &&
    replay.walletOutpoints.includes(outpoint) && split.inputOutpoints.includes(outpoint)
  ) return true;

  if (
    replay && btc && replay.txid === btc.txid &&
    replay.walletInputOutpoints.includes(outpoint) && btc.inputOutpoints.includes(outpoint)
  ) return true;

  if (replay && btc && replay.walletOutpoints.includes(outpoint)) {
    return Boolean(btc.replayRisk || btc.replayProtection?.splitIntentIds.length) ||
      allIntents.some((candidate) =>
        candidate.kind === "blake-unified" && candidate.phase !== "abandoned" &&
        candidate.parentReplayIntentIds.includes(replay.id) &&
        candidate.inputOutpoints.includes(outpoint) &&
        allowedSplitBtcPair(candidate, btc, outpoint)
      );
  }
  return false;
}

export function assertWalletStateInvariants(state: WalletPublicState): void {
  assertBpubState(state);
  const coinOutpoints = new Set<string>();
  for (const coin of state.coins) {
    if (
      !OUTPOINT.test(coin.outpoint) || coinOutpoints.has(coin.outpoint) ||
      !TXID.test(coin.txid) || !Number.isSafeInteger(coin.vout) || coin.vout < 0 ||
      coin.vout > 0xffff_ffff || coin.outpoint !== `${coin.txid}:${coin.vout}` ||
      !Number.isSafeInteger(coin.value) || coin.value <= 0 ||
      typeof coin.address !== "string" || coin.address.length === 0 ||
      !/^5120[0-9a-f]{64}$/u.test(coin.scriptPubKey) ||
      !/^m\/86'\/0'\/0'\/[01]\/(?:0|[1-9]\d*)$/u.test(coin.path)
    ) {
      throw new Error("Wallet contains duplicate or malformed coin records");
    }
    assertCoinObservation(coin.blake, `Coin ${coin.outpoint} BLAKE`);
    assertCoinObservation(coin.btc, `Coin ${coin.outpoint} BTC`);
    coinOutpoints.add(coin.outpoint);
  }

  for (const [outpoint, provenance] of Object.entries(state.sharedProvenance)) {
    if (!OUTPOINT.test(outpoint) || !validTimestamp(provenance.firstObservedAt)) {
      throw new Error("Wallet contains malformed shared provenance");
    }
  }

  const intents = new Map<string, TransactionIntent>();
  for (const intent of state.intents) {
    assertTransactionIntent(intent);
    if (intents.has(intent.id)) throw new Error(`Duplicate transaction intent ${intent.id}`);
    intents.set(intent.id, intent);
    if (
      intent.kind === "blake-unified" &&
      intent.sharedOutpoints.some((outpoint) => !state.sharedProvenance[outpoint])
    ) {
      throw new Error(`Split intent ${intent.txid} lost shared provenance`);
    }
  }

  for (const intent of state.intents) {
    if (intent.kind === "blake-unified") {
      for (const parentIntentId of intent.parentReplayIntentIds) {
        const parent = intents.get(parentIntentId);
        if (
          !parent || parent.kind !== "blake-replay" ||
          !parent.walletOutpoints.some((outpoint) => intent.inputOutpoints.includes(outpoint))
        ) {
          throw new Error(`Split intent ${intent.txid} has a missing replay dependency`);
        }
      }
    } else if (intent.kind === "btc-spend") {
      const references = [
        ...(intent.replayRisk?.splitIntentIds ?? []),
        ...(intent.replayProtection?.splitIntentIds ?? []),
      ];
      for (const splitIntentId of references) {
        const split = intents.get(splitIntentId);
        if (
          !split || split.kind !== "blake-unified" ||
          !split.sharedOutpoints.some((outpoint) => intent.inputOutpoints.includes(outpoint))
        ) {
          throw new Error(`BTC intent ${intent.txid} has a missing split-safety reference`);
        }
      }
    }
  }

  const activeByOutpoint = new Map<string, TransactionIntent[]>();
  for (const intent of state.intents) {
    if (intent.phase === "confirmed" || intent.phase === "abandoned") continue;
    for (const outpoint of intentOutpoints(intent)) {
      const active = activeByOutpoint.get(outpoint) ?? [];
      for (const existing of active) {
        if (!allowedActivePair(existing, intent, outpoint, state.intents)) {
          throw new Error(`Outpoint ${outpoint} is governed by incompatible active intents`);
        }
      }
      active.push(intent);
      activeByOutpoint.set(outpoint, active);
    }
  }
}

export function summarizeIntent(
  intent: TransactionIntent,
  allIntents: TransactionIntent[],
  sharedProvenance: Record<string, unknown> = {},
): IntentSummary {
  const protectedByConfirmedSplit = intent.kind === "btc-spend" && intent.replayProtection &&
    intent.replayProtection.splitIntentIds.some((id) =>
      splitProvidesConfirmedProtection(
        allIntents.find((candidate) => candidate.id === id),
        allIntents,
      )
    );
  const blockedBy = intent.kind === "blake-bpub-reveal"
    ? allIntents.some((i) =>
        i.id === intent.fundingIntentId && (i.phase === "seen" || i.phase === "confirmed")
      )
      ? []
      : [intent.fundingIntentId]
    : intent.kind === "blake-unified"
    ? intent.parentReplayIntentIds.filter((id) =>
      !parentReplayAccepted(allIntents.find((candidate) => candidate.id === id))
    )
    : intent.kind === "btc-spend" && intent.replayProtection && !protectedByConfirmedSplit
    ? [...intent.replayProtection.splitIntentIds]
    : [];
  const protectsBtcSpend = intent.kind === "blake-unified" &&
    allIntents.some((candidate) => btcIntentReliesOnSplit(candidate, intent.id));
  const unexposedPrepared = intent.phase === "prepared" &&
    intent.broadcastStartedAt === undefined;
  return {
    id: intent.id,
    txid: intent.txid,
    kind: intent.kind,
    action: intent.kind === "blake-replay"
      ? "replay"
      : intent.kind === "blake-unified" && intent.sharedOutpoints.length > 0
      ? "split"
      : "send",
    chain: intent.chain,
    phase: intent.phase,
    outpoints: [
      ...(intent.kind === "blake-replay" ? intent.walletOutpoints : intent.inputOutpoints),
    ],
    createdAt: intent.createdAt,
    lastError: intent.lastError,
    blockedBy,
    canRebroadcast: intent.kind !== "blake-bpub-reveal" && blockedBy.length === 0 &&
      (intent.phase === "prepared" || intent.phase === "recoverable" ||
        intent.phase === "broadcast-unknown"),
    canAbandon: intent.kind !== "blake-bpub-reveal" &&
      !allIntents.some((i) => i.kind === "blake-bpub-reveal" && i.fundingIntentId === intent.id) &&
      (blockedBy.length === 0 || unexposedPrepared) &&
      !protectsBtcSpend &&
      !(intent.kind === "blake-replay" &&
        intent.walletOutpoints.some((outpoint) => sharedProvenance[outpoint])) &&
      (intent.phase === "prepared" || intent.phase === "recoverable"),
  };
}
