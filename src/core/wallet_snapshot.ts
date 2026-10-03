import { deriveCoinPolicy } from "./coin_policy.ts";
import { summarizePublication } from "./bpub_state.ts";
import { summarizeIntent } from "./intent_state.ts";
import { observationsAreStale, STALE_OBSERVATIONS_WARNING } from "./observation_freshness.ts";
import type { WalletLockState, WalletPublicState, WalletSnapshot } from "./types.ts";
import { canIssueNextReceiveAddress } from "./wallet_sync.ts";

/** Build the immutable, UI-facing view without exposing persisted safety state. */
export function buildWalletSnapshot(
  state: WalletPublicState,
  lockState: WalletLockState,
): WalletSnapshot {
  const policies = state.coins.map((coin) =>
    deriveCoinPolicy(
      coin,
      Boolean(state.sharedProvenance[coin.outpoint]),
      state.intents,
      state.settings,
    )
  );
  const outputs = policies.map((policy) => policy.output);
  const receiveIndex = Math.max(0, state.nextReceiveIndex - 1);
  const receiveAddress = state.recoveryScanComplete
    ? state.addresses.find((address) => address.branch === 0 && address.index === receiveIndex)
    : undefined;
  const canCreateReceiveAddress = lockState === "unlocked" && state.recoveryScanComplete &&
    canIssueNextReceiveAddress(state);
  const blake = outputs.reduce(
    (total, output) =>
      total + (output.blake.tx?.present && output.blake.unspent ? output.value : 0),
    0,
  );
  const btc = outputs.reduce(
    (total, output) => total + (output.btc.tx?.present && output.btc.unspent ? output.value : 0),
    0,
  );
  const selectableBlakeOutpoints = policies.filter((policy) => policy.blakeSelectable)
    .map((policy) => policy.output.outpoint);
  const selectableBtcOutpoints = policies.filter((policy) => policy.btcSelectable)
    .map((policy) => policy.output.outpoint);
  const splittableOutpoints = policies.filter((policy) => policy.splittable)
    .map((policy) => policy.output.outpoint);
  const replayCandidateTxids = state.recoveryScanComplete
    ? [
      ...new Set(
        policies.filter((policy) => policy.replayCandidate).map((policy) => policy.output.txid),
      ),
    ]
    : [];
  const blakeSet = new Set(selectableBlakeOutpoints);
  const btcSet = new Set(selectableBtcOutpoints);
  const sharedSet = new Set(splittableOutpoints);
  const spendableBlake = outputs.reduce(
    (total, output) => total + (blakeSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const spendableBtc = outputs.reduce(
    (total, output) => total + (btcSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const shared = outputs.reduce(
    (total, output) => total + (sharedSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const hasUnspentOutput = outputs.some((output) =>
    output.blake.unspent === true || output.btc.unspent === true
  );
  const stale = observationsAreStale(state.lastSyncAt, hasUnspentOutput);
  const warnings = [
    ...(stale ? [STALE_OBSERVATIONS_WARNING] : []),
    ...(!state.recoveryScanComplete
      ? [`Recovery scan is in progress at address index ${state.recoveryScan?.nextIndex ?? 0}.`]
      : []),
    ...(state.lastSyncError ? [`Last sync: ${state.lastSyncError}`] : []),
  ];
  const {
    coins: _coins,
    sharedProvenance: _provenance,
    intents: _intents,
    publications: _publications,
    ...publicState
  } = structuredClone(state);
  return {
    ...publicState,
    lockState,
    publications: lockState === "unlocked"
      ? state.publications.map((p) => summarizePublication(state, p))
      : [],
    receiveAddress: receiveAddress ? structuredClone(receiveAddress) : undefined,
    canCreateReceiveAddress,
    outputs,
    intents: state.intents.map((intent) =>
      summarizeIntent(intent, state.intents, state.sharedProvenance)
    ),
    balances: { blake, btc, spendableBlake, spendableBtc, shared },
    selectableBlakeOutpoints,
    selectableBtcOutpoints,
    splittableOutpoints,
    replayCandidateTxids,
    warnings,
  };
}
