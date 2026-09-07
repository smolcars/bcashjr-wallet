import { ChainVerifier } from "./chain_verifier.ts";
import { EsploraClient, normalizeEsploraUrl } from "./esplora.ts";
import {
  Bip86Keychain,
  entropyFromMnemonic,
  mnemonicFromEntropy,
  newMnemonic,
  protectEntropy,
  type SecretRecord,
  unprotectEntropy,
} from "./keys.ts";
import { ReplayWorkflow } from "./replay_workflow.ts";
import { SpendWorkflow } from "./spend_workflow.ts";
import { IntentReconciler } from "./intent_reconciler.ts";
import { IntentWorkflow } from "./intent_workflow.ts";
import { assertWalletStateInvariants, type IntentEvent, reduceIntent } from "./intent_state.ts";
import { buildWalletSnapshot } from "./wallet_snapshot.ts";
import {
  consecutiveUnusedReceiveAddresses,
  ensureInitialAddress,
  reconcileDerivedPublicState,
} from "./wallet_integrity.ts";
import type { WalletRepository } from "./storage.ts";
import { MAX_FEE_RATE } from "./transaction.ts";
import {
  type BroadcastResult,
  type ChainId,
  type CreateWalletRequest,
  emptyPublicState,
  type ReplayPreview,
  type RestoreWalletRequest,
  type SpendPreview,
  type SpendPreviewRequest,
  type WalletPublicState,
  type WalletSettingsUpdate,
  type WalletSnapshot,
} from "./types.ts";
import {
  advanceReceiveAddressAfterConfirmedDeposit,
  advanceReceiveAddressPastUsed,
  canIssueNextReceiveAddress,
  installDiscoveredOutputs,
  issueNextUnusedReceiveAddress,
  scanCurrentUtxos,
  scanRecoveryAddresses,
  settledErrorReason,
} from "./wallet_sync.ts";

export interface CreatedWallet {
  mnemonic: string;
  snapshot: WalletSnapshot;
}

export type ClientFactory = (chain: ChainId, apiUrl: string) => EsploraClient;

function containsInitializedWalletState(state: WalletPublicState): boolean {
  return state.createdAt !== undefined || state.recoveryPhraseAcknowledged ||
    state.recoveryScanComplete || state.recoveryScan !== undefined ||
    state.nextReceiveIndex !== 0 || state.addresses.length > 0 || state.coins.length > 0 ||
    state.intents.length > 0 || Object.keys(state.sharedProvenance).length > 0 ||
    Object.keys(state.tips).length > 0 || state.lastSyncAt !== undefined ||
    state.lastSyncError !== undefined;
}

export class WalletService {
  #state: WalletPublicState = emptyPublicState();
  #persistedState: WalletPublicState = emptyPublicState();
  #secret: SecretRecord | null = null;
  #keychain: Bip86Keychain | null = null;
  #pendingRecoveryEntropy: Uint8Array | null = null;
  #intentWorkflow: IntentWorkflow;
  #spendWorkflow: SpendWorkflow;
  #replayWorkflow: ReplayWorkflow;
  #syncing: Promise<WalletSnapshot> | null = null;
  #operationQueue: Promise<void> = Promise.resolve();
  #chainVerifier = new ChainVerifier();
  #intentReconciler = new IntentReconciler(() => this.#state);

  constructor(
    readonly repository: WalletRepository,
    readonly clientFactory: ClientFactory = (_chain, url) => new EsploraClient(url),
    readonly now: () => number = Date.now,
  ) {
    this.#intentWorkflow = new IntentWorkflow({
      state: () => this.#state,
      requireKeychain: () => this.#requireKeychain(),
      clients: () => this.#clients(),
      verifiedTip: (chain, client) => this.#chainVerifier.verifiedTip(chain, client),
      refreshOneIntent: (intentId, client, tipHeight) =>
        this.#intentReconciler.refreshOne(intentId, client, tipHeight),
      saveWorkingState: () => this.#saveWorkingState(),
      commit: (mutator) => this.#commit(mutator),
      transitionIntent: (intentId, event) => this.#transitionIntent(intentId, event),
    });
    this.#spendWorkflow = new SpendWorkflow({
      state: () => this.#state,
      requireKeychain: () => this.#requireKeychain(),
      clients: () => this.#clients(),
      verifiedTip: (chain, client) => this.#chainVerifier.verifiedTip(chain, client),
      refreshIntentStatuses: (clients, tipHeights, errors, relevantOutpoints) =>
        this.#intentReconciler.refreshStatuses(
          clients,
          tipHeights,
          errors,
          relevantOutpoints,
        ),
      saveWorkingState: () => this.#saveWorkingState(),
      storePreparedIntent: (intent) => this.#intentWorkflow.storePrepared(intent),
      transitionIntent: (intentId, event) => this.#transitionIntent(intentId, event),
      broadcastIntent: (intentId, client) => this.#intentWorkflow.broadcast(intentId, client),
      now: () => this.now(),
    });
    this.#replayWorkflow = new ReplayWorkflow({
      state: () => this.#state,
      requireKeychain: () => this.#requireKeychain(),
      clients: () => this.#clients(),
      verifiedTip: (chain, client) => this.#chainVerifier.verifiedTip(chain, client),
      refreshIntentStatuses: (clients, tipHeights, errors, relevantOutpoints) =>
        this.#intentReconciler.refreshStatuses(
          clients,
          tipHeights,
          errors,
          relevantOutpoints,
        ),
      saveWorkingState: () => this.#saveWorkingState(),
      commit: (mutator) => this.#commit(mutator),
      storePreparedIntent: (intent) => this.#intentWorkflow.storePrepared(intent),
      transitionIntent: (intentId, event) => this.#transitionIntent(intentId, event),
      broadcastIntent: (intentId, client) => this.#intentWorkflow.broadcast(intentId, client),
      rebroadcastProtectionChildren: (parentIntentId) =>
        this.#intentWorkflow.rebroadcastProtectionChildren(parentIntentId),
      now: () => this.now(),
    });
  }

  async initialize(): Promise<WalletSnapshot> {
    const state = await this.repository.loadState();
    const secret = await this.repository.loadSecret();
    if (!secret && containsInitializedWalletState(state)) {
      throw new Error(
        "Wallet data is incomplete: wallet.json exists without its encrypted secret",
      );
    }
    this.#state = state;
    this.#persistedState = structuredClone(state);
    this.#secret = secret;
    return this.snapshot();
  }

  snapshot(): WalletSnapshot {
    this.#purgeExpiredPreviews();
    const lockState = !this.#secret ? "empty" : this.#keychain ? "unlocked" : "locked";
    return buildWalletSnapshot(this.#state, lockState);
  }

  createWallet(request: CreateWalletRequest): Promise<CreatedWallet> {
    return this.#serialized(async () => {
      if (this.#secret) throw new Error("A wallet already exists in this data directory");
      const mnemonic = newMnemonic();
      return await this.#installWallet(mnemonic, request, true, false);
    });
  }

  restoreWallet(request: RestoreWalletRequest): Promise<CreatedWallet> {
    return this.#serialized(async () => {
      if (this.#secret) throw new Error("A wallet already exists in this data directory");
      if (!request || typeof request.mnemonic !== "string" || request.mnemonic.length > 512) {
        throw new Error("A 12-word recovery phrase is required");
      }
      return await this.#installWallet(request.mnemonic, request, false, true);
    });
  }

  async #installWallet(
    mnemonic: string,
    request: CreateWalletRequest,
    recoveryScanComplete: boolean,
    recoveryPhraseAcknowledged: boolean,
  ): Promise<CreatedWallet> {
    const password = request?.password;
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("Local encryption password is required");
    }
    if (password.length > 1_024) {
      throw new Error("Local encryption password is too long");
    }
    const entropy = entropyFromMnemonic(mnemonic);
    let pendingKeychain: Bip86Keychain | null = null;
    try {
      const secret = await protectEntropy(entropy, password);
      const now = new Date().toISOString();
      const state: WalletPublicState = {
        ...emptyPublicState(),
        createdAt: now,
        recoveryPhraseAcknowledged,
        recoveryScanComplete,
      };
      pendingKeychain = new Bip86Keychain(entropy);
      ensureInitialAddress(state, pendingKeychain);
      assertWalletStateInvariants(state);

      // The encrypted seed must exist before any public wallet state can expose an address.
      // Publish the new wallet to this service only after both durable writes succeed.
      await this.repository.saveSecret(secret);
      await this.repository.saveState(state);

      this.#state = structuredClone(state);
      this.#persistedState = structuredClone(state);
      this.#secret = structuredClone(secret);
      this.#keychain = pendingKeychain;
      pendingKeychain = null;
      this.#replacePendingRecoveryEntropy(recoveryPhraseAcknowledged ? null : entropy);
      return {
        mnemonic: recoveryPhraseAcknowledged ? "" : mnemonicFromEntropy(entropy),
        snapshot: this.snapshot(),
      };
    } finally {
      pendingKeychain?.destroy();
      entropy.fill(0);
    }
  }

  unlock(password: string): Promise<WalletSnapshot> {
    return this.#serialized(async () => {
      if (!this.#secret) throw new Error("No wallet exists");
      if (this.#keychain) return this.snapshot();
      if (typeof password !== "string" || password.length === 0) {
        throw new Error("Local encryption password is required");
      }
      if (password.length > 1_024) {
        throw new Error("Local encryption password is too long");
      }
      const entropy = await unprotectEntropy(this.#secret, password);
      try {
        this.#keychain = new Bip86Keychain(entropy);
        this.#replacePendingRecoveryEntropy(
          this.#state.recoveryPhraseAcknowledged ? null : entropy,
        );
      } finally {
        entropy.fill(0);
      }
      try {
        await this.#reconcileDerivedPublicState();
        await this.#ensureInitialAddress();
        return this.snapshot();
      } catch (error) {
        this.#keychain?.destroy();
        this.#keychain = null;
        this.#replacePendingRecoveryEntropy(null);
        throw error;
      }
    });
  }

  recoveryPhrase(): Promise<string> {
    return this.#serialized(() => {
      this.#requireKeychain();
      if (this.#state.recoveryPhraseAcknowledged) {
        throw new Error("The recovery phrase has already been acknowledged");
      }
      if (!this.#pendingRecoveryEntropy) {
        throw new Error("Lock and unlock the wallet to recover the pending recovery phrase");
      }
      return mnemonicFromEntropy(this.#pendingRecoveryEntropy);
    });
  }

  acknowledgeRecoveryPhrase(): Promise<WalletSnapshot> {
    return this.#serialized(async () => {
      this.#requireKeychain();
      if (this.#state.recoveryPhraseAcknowledged) return this.snapshot();
      this.#state.recoveryPhraseAcknowledged = true;
      try {
        await this.#saveWorkingState();
      } catch (error) {
        this.#state.recoveryPhraseAcknowledged = false;
        throw error;
      }
      this.#replacePendingRecoveryEntropy(null);
      return this.snapshot();
    });
  }

  lock(): Promise<WalletSnapshot> {
    return this.#serialized(() => {
      this.#keychain?.destroy();
      this.#keychain = null;
      this.#replacePendingRecoveryEntropy(null);
      this.#spendWorkflow.clear();
      this.#replayWorkflow.clear();
      return this.snapshot();
    });
  }

  newReceiveAddress(): Promise<WalletSnapshot> {
    return this.#serialized(async () => {
      const keychain = this.#requireKeychain();
      if (!this.#state.recoveryScanComplete) {
        throw new Error("Finish the recovery scan before creating a receive address");
      }
      if (!canIssueNextReceiveAddress(this.#state)) {
        throw new Error(
          `The ${this.#state.settings.scanGap}-address recovery gap is full; use or sync an issued address before creating another`,
        );
      }
      issueNextUnusedReceiveAddress(this.#state, keychain);
      await this.#saveWorkingState();
      return this.snapshot();
    });
  }

  updateSettings(update: WalletSettingsUpdate): Promise<WalletSnapshot> {
    return this.#serialized(() => this.#updateSettings(update));
  }

  async #updateSettings(update: WalletSettingsUpdate): Promise<WalletSnapshot> {
    if (!update || typeof update !== "object") throw new Error("Malformed settings update");
    const next = { ...this.#state.settings };
    if (update.blakeApiUrl !== undefined) {
      if (typeof update.blakeApiUrl !== "string") throw new Error("Invalid BLAKE backend URL");
      next.blakeApiUrl = update.blakeApiUrl;
    }
    if (update.btcApiUrl !== undefined) {
      if (typeof update.btcApiUrl !== "string") throw new Error("Invalid BTC backend URL");
      next.btcApiUrl = update.btcApiUrl;
    }
    if (update.amountUnit !== undefined) {
      if (
        update.amountUnit !== "sat" && update.amountUnit !== "btc" &&
        update.amountUnit !== "bip177"
      ) {
        throw new Error("Invalid amount denomination");
      }
      next.amountUnit = update.amountUnit;
    }
    for (const key of ["btcConfirmations", "blakeConfirmations", "scanGap"] as const) {
      if (update[key] !== undefined) next[key] = update[key];
    }
    for (const key of ["btcFeeRate", "blakeFeeRate"] as const) {
      if (update[key] === null) delete next[key];
      else if (update[key] !== undefined) next[key] = update[key];
    }
    next.blakeApiUrl = normalizeEsploraUrl(next.blakeApiUrl);
    next.btcApiUrl = normalizeEsploraUrl(next.btcApiUrl);
    for (const chain of ["btc", "blake"] as const) {
      const confirmations = next[`${chain}Confirmations`];
      if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 1_000) {
        throw new Error(`${chain.toUpperCase()} confirmations must be an integer from 0 to 1,000`);
      }
    }
    if (!Number.isSafeInteger(next.scanGap) || next.scanGap < 1 || next.scanGap > 1_000) {
      throw new Error("Address gap must be an integer from 1 to 1,000");
    }
    const unusedIssuedAddresses = consecutiveUnusedReceiveAddresses(this.#state);
    if (next.scanGap < unusedIssuedAddresses) {
      throw new Error(
        `Address gap cannot be lower than the ${unusedIssuedAddresses} consecutive unused addresses already issued`,
      );
    }
    for (const key of ["btcFeeRate", "blakeFeeRate"] as const) {
      const feeRate = next[key];
      if (
        feeRate !== undefined &&
        (!Number.isFinite(feeRate) || feeRate <= 0 || feeRate > MAX_FEE_RATE)
      ) {
        const chain = key === "btcFeeRate" ? "BTC" : "BLAKE";
        throw new Error(`${chain} fee rate must be between 0 and ${MAX_FEE_RATE} sat/vB`);
      }
    }
    const scanGapIncreased = next.scanGap > this.#state.settings.scanGap;
    const confirmationTargetsChanged =
      next.btcConfirmations !== this.#state.settings.btcConfirmations ||
      next.blakeConfirmations !== this.#state.settings.blakeConfirmations;
    this.#state.settings = next;
    if (confirmationTargetsChanged) this.#intentReconciler.reapplyConfirmationTargets();
    if (scanGapIncreased && this.#state.recoveryScanComplete) {
      const addresses = this.#state.addresses
        .filter((address) => address.branch === 0)
        .sort((left, right) => left.index - right.index);
      let trailingGap = 0;
      let nextIndex = 0;
      for (const address of addresses) {
        if (address.index !== nextIndex) break;
        trailingGap = address.used ? 0 : trailingGap + 1;
        nextIndex++;
      }
      this.#state.recoveryScanComplete = false;
      this.#state.recoveryScan = {
        nextIndex,
        trailingGap,
      };
    }
    await this.#saveWorkingState();
    return this.snapshot();
  }

  sync(): Promise<WalletSnapshot> {
    if (this.#syncing) return this.#syncing;
    const operation = this.#serialized(() => this.#performSync());
    this.#syncing = operation;
    operation.then(
      () => {
        if (this.#syncing === operation) this.#syncing = null;
      },
      () => {
        if (this.#syncing === operation) this.#syncing = null;
      },
    );
    return operation;
  }

  fullRescan(): Promise<WalletSnapshot> {
    return this.#serialized(async () => {
      this.#requireKeychain();
      await this.#commit((draft) => {
        draft.recoveryScanComplete = false;
        draft.recoveryScan = { nextIndex: 0, trailingGap: 0 };
        delete draft.lastSyncAt;
        delete draft.lastSyncError;
      });
      return await this.#performSync();
    });
  }

  async #performSync(): Promise<WalletSnapshot> {
    if (!this.#secret) throw new Error("Create or restore a wallet before syncing");
    this.#requireKeychain();
    const clients = this.#clients();
    const tipResults = await Promise.allSettled([
      this.#chainVerifier.verifiedTip("blake", clients.blake),
      this.#chainVerifier.verifiedTip("btc", clients.btc),
    ]);
    const blakeTip = tipResults[0].status === "fulfilled" ? tipResults[0].value : null;
    const btcTip = tipResults[1].status === "fulfilled" ? tipResults[1].value : null;
    const errors: string[] = [];
    if (!blakeTip) errors.push(`BLAKE: ${settledErrorReason(tipResults[0])}`);
    if (!btcTip) errors.push(`BTC: ${settledErrorReason(tipResults[1])}`);
    if (blakeTip) this.#state.tips.blake = blakeTip;
    if (btcTip) this.#state.tips.btc = btcTip;
    if (!blakeTip && !btcTip) {
      this.#state.lastSyncError = errors.join("; ");
      await this.#saveWorkingState();
      return this.snapshot();
    }

    const recovering = !this.#state.recoveryScanComplete;
    const available = { blake: Boolean(blakeTip), btc: Boolean(btcTip) };
    let scan = recovering && blakeTip && btcTip
      ? await scanRecoveryAddresses(this.#state, this.#keychain, clients, errors)
      : await scanCurrentUtxos(this.#state, clients, errors, available);
    let recoveryVerified = false;
    if (recovering && scan.complete) {
      const finalScan = await scanCurrentUtxos(this.#state, clients, errors, available);
      if (finalScan.authoritative) {
        scan = finalScan;
        recoveryVerified = true;
      }
    }
    installDiscoveredOutputs(
      this.#state,
      scan,
      blakeTip?.height ?? this.#state.tips.blake?.height ?? 0,
      btcTip?.height ?? this.#state.tips.btc?.height ?? 0,
    );
    await this.#intentReconciler.refreshStatuses(
      clients,
      {
        ...(blakeTip ? { blake: blakeTip.height } : {}),
        ...(btcTip ? { btc: btcTip.height } : {}),
      },
      errors,
    );
    if (recovering && recoveryVerified) {
      this.#state.recoveryScanComplete = true;
      this.#state.recoveryScan = undefined;
      advanceReceiveAddressPastUsed(this.#state, this.#keychain);
    } else if (!recovering) {
      advanceReceiveAddressAfterConfirmedDeposit(this.#state, this.#keychain);
    }
    if (scan.authoritative) this.#state.lastSyncAt = new Date().toISOString();
    this.#state.lastSyncError = errors.length ? errors.join("; ") : undefined;
    await this.#saveWorkingState();
    return this.snapshot();
  }

  previewSpend(request: SpendPreviewRequest): Promise<SpendPreview> {
    return this.#serialized(() => this.#spendWorkflow.preview(request));
  }

  confirmSpend(
    previewId: string,
    acceptHighFee = false,
    acceptReplayRisk = false,
  ): Promise<BroadcastResult> {
    return this.#serialized(() =>
      this.#spendWorkflow.confirm(previewId, acceptHighFee, acceptReplayRisk)
    );
  }

  cancelSpendPreview(previewId: string): Promise<void> {
    return this.#serialized(() => {
      this.#spendWorkflow.cancel(previewId);
    });
  }

  previewReplay(txid: string): Promise<ReplayPreview> {
    return this.#serialized(() => this.#replayWorkflow.preview(txid));
  }

  confirmReplay(previewId: string): Promise<BroadcastResult> {
    return this.#serialized(() => this.#replayWorkflow.confirm(previewId));
  }

  cancelReplayPreview(previewId: string): Promise<void> {
    return this.#serialized(() => {
      this.#replayWorkflow.cancel(previewId);
    });
  }

  rebroadcastIntent(intentId: string): Promise<BroadcastResult> {
    return this.#serialized(() => this.#intentWorkflow.rebroadcast(intentId));
  }

  abandonIntent(intentId: string): Promise<WalletSnapshot> {
    return this.#serialized(async () => {
      await this.#intentWorkflow.abandon(intentId);
      return this.snapshot();
    });
  }

  async #reconcileDerivedPublicState(): Promise<void> {
    const keychain = this.#requireKeychain();
    if (reconcileDerivedPublicState(this.#state, keychain)) await this.#saveWorkingState();
  }

  async #ensureInitialAddress(): Promise<void> {
    if (ensureInitialAddress(this.#state, this.#keychain)) await this.#saveWorkingState();
  }

  #clients(): { blake: EsploraClient; btc: EsploraClient } {
    const blakeApiUrl = normalizeEsploraUrl(this.#state.settings.blakeApiUrl);
    const btcApiUrl = normalizeEsploraUrl(this.#state.settings.btcApiUrl);
    return {
      blake: this.clientFactory("blake", blakeApiUrl),
      btc: this.clientFactory("btc", btcApiUrl),
    };
  }

  async #saveWorkingState(): Promise<void> {
    const committed = structuredClone(this.#state);
    try {
      assertWalletStateInvariants(committed);
      await this.repository.saveState(committed);
    } catch (error) {
      this.#state = structuredClone(this.#persistedState);
      throw error;
    }
    this.#state = committed;
    this.#persistedState = structuredClone(committed);
  }

  #purgeExpiredPreviews(): void {
    this.#spendWorkflow.purgeExpired();
    this.#replayWorkflow.purgeExpired();
  }

  #requireKeychain(): Bip86Keychain {
    if (!this.#keychain) throw new Error("Unlock the wallet first");
    return this.#keychain;
  }

  #replacePendingRecoveryEntropy(entropy: Uint8Array | null): void {
    this.#pendingRecoveryEntropy?.fill(0);
    this.#pendingRecoveryEntropy = entropy ? Uint8Array.from(entropy) : null;
  }

  async #commit(mutator: (draft: WalletPublicState) => void): Promise<void> {
    const draft = structuredClone(this.#state);
    mutator(draft);
    assertWalletStateInvariants(draft);
    await this.repository.saveState(draft);
    this.#state = draft;
    this.#persistedState = structuredClone(draft);
  }

  async #transitionIntent(intentId: string, event: IntentEvent): Promise<void> {
    await this.#commit((draft) => {
      const index = draft.intents.findIndex((intent) => intent.id === intentId);
      if (index < 0) throw new Error(`Transaction intent ${intentId} is missing`);
      draft.intents[index] = reduceIntent(draft.intents[index], event);
    });
  }

  #serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.#operationQueue.then(operation, operation);
    this.#operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
