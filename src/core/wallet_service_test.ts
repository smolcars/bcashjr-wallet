import { RawTx, SigHash, Transaction } from "@scure/btc-signer";
import { fromHex } from "./bytes.ts";
import {
  type EsploraAddress,
  EsploraClient,
  type EsploraTxStatus,
  type EsploraUtxo,
} from "./esplora.ts";
import { Bip86Keychain, entropyFromMnemonic, protectEntropy, type SecretRecord } from "./keys.ts";
import { IntentReconciler } from "./intent_reconciler.ts";
import { MemoryWalletRepository, parseWalletState } from "./storage.ts";
import {
  createSweepTemplate,
  RBF_SEQUENCE,
  signBtcSweep,
  signUnifiedSweep,
} from "./transaction.ts";
import {
  type ChainCoinObservation,
  type ChainId,
  emptyPublicState,
  type PersistedCoin,
  type WalletAddress,
  type WalletPublicState,
} from "./types.ts";
import { WalletService } from "./wallet_service.ts";

const RECOVERY =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "wallet test password";
const CHECKPOINTS: Record<ChainId, string> = {
  blake: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb",
  btc: "00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00",
};

const FIXTURE_ADDRESSES = (() => {
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  try {
    return [
      keychain.derive(0, 0),
      keychain.derive(0, 1),
      keychain.derive(0, 2),
    ] as const;
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
})();

let encryptedSecretPromise: Promise<SecretRecord> | undefined;

function encryptedSecret(): Promise<SecretRecord> {
  encryptedSecretPromise ??= (async () => {
    const entropy = entropyFromMnemonic(RECOVERY);
    try {
      return await protectEntropy(entropy, PASSWORD);
    } finally {
      entropy.fill(0);
    }
  })();
  return encryptedSecretPromise.then((secret) => structuredClone(secret));
}

function observation(
  present: boolean,
  unspent: boolean,
  checkedAt = new Date().toISOString(),
  confirmed = true,
): ChainCoinObservation {
  return {
    checkedAt,
    backendOk: true,
    tx: {
      present,
      confirmed: present && confirmed,
      confirmations: present && confirmed ? 2 : 0,
    },
    unspent,
  };
}

function coin(
  txid: string,
  value: number,
  address: WalletAddress,
  onBlake: boolean,
  onBtc: boolean,
  confirmed = true,
): PersistedCoin {
  return {
    outpoint: `${txid}:0`,
    txid,
    vout: 0,
    value,
    address: address.address,
    scriptPubKey: address.scriptPubKey,
    path: address.path,
    blake: observation(onBlake, onBlake, undefined, confirmed),
    btc: observation(onBtc, onBtc, undefined, confirmed),
  };
}

function baseState(coins: PersistedCoin[] = []): WalletPublicState {
  const state = emptyPublicState();
  state.recoveryPhraseAcknowledged = true;
  state.recoveryScanComplete = true;
  state.nextReceiveIndex = 1;
  state.addresses = [{ ...FIXTURE_ADDRESSES[0] }];
  state.coins = structuredClone(coins);
  state.tips = {
    blake: { height: 961_650, fetchedAt: new Date().toISOString() },
    btc: { height: 961_650, fetchedAt: new Date().toISOString() },
  };
  state.lastSyncAt = new Date().toISOString();
  return state;
}

class MockEsplora extends EsploraClient {
  tip = 961_650;
  checkpointHash: string;
  tipFailure: Error | null = null;
  addressRequests = 0;
  utxos = new Map<string, EsploraUtxo[]>();
  usedAddresses = new Set<string>();
  statuses = new Map<string, EsploraTxStatus | null>();
  transactionHexes = new Map<string, string>();
  broadcasts: string[] = [];
  broadcastFailures = new Map<string, Error>();
  malformedUtxos = false;
  utxoFailure: Error | null = null;
  statusFailure: Error | null = null;
  broadcastFailure: Error | null = null;
  beforeBroadcast?: (rawTx: string) => void | Promise<void>;

  constructor(readonly chain: ChainId) {
    super(`https://${chain}.example/api`);
    this.checkpointHash = CHECKPOINTS[chain];
  }

  override tipHeight(): Promise<number> {
    if (this.tipFailure) return Promise.reject(this.tipFailure);
    return Promise.resolve(this.tip);
  }

  override blockHash(_height: number): Promise<string> {
    return Promise.resolve(this.checkpointHash);
  }

  override address(address: string): Promise<EsploraAddress> {
    this.addressRequests++;
    const used = this.usedAddresses.has(address) || (this.utxos.get(address)?.length ?? 0) > 0;
    const count = used ? 1 : 0;
    const stats = {
      funded_txo_count: count,
      funded_txo_sum: used ? 1 : 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: count,
    };
    return Promise.resolve({
      address,
      chain_stats: stats,
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    });
  }

  override addressUtxos(address: string): Promise<EsploraUtxo[]> {
    if (this.utxoFailure) return Promise.reject(this.utxoFailure);
    if (this.malformedUtxos) {
      return Promise.resolve([{ unexpected: true }] as unknown as EsploraUtxo[]);
    }
    return Promise.resolve(structuredClone(this.utxos.get(address) ?? []));
  }

  override transactionStatus(txid: string): Promise<EsploraTxStatus | null> {
    if (this.statusFailure) return Promise.reject(this.statusFailure);
    return Promise.resolve(structuredClone(this.statuses.get(txid) ?? null));
  }

  override transactionHex(txid: string): Promise<string> {
    const rawTx = this.transactionHexes.get(txid);
    if (!rawTx) return Promise.reject(new Error("Transaction hex not found"));
    return Promise.resolve(rawTx);
  }

  override recommendedFees(): Promise<{ fastestFee: number }> {
    return Promise.resolve({ fastestFee: 2 });
  }

  override async broadcast(rawTx: string): Promise<string> {
    await this.beforeBroadcast?.(rawTx);
    const transaction = Transaction.fromRaw(fromHex(rawTx), {
      allowUnknownVersion: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    const failure = this.broadcastFailures.get(transaction.id) ?? this.broadcastFailure;
    if (failure) throw failure;
    this.broadcasts.push(rawTx);
    this.statuses.set(transaction.id, { confirmed: false });
    return transaction.id;
  }
}

class FailingMemoryWalletRepository extends MemoryWalletRepository {
  failNextStateSave = false;
  failNextSecretSave = false;

  override saveState(state: WalletPublicState): Promise<void> {
    if (this.failNextStateSave) {
      this.failNextStateSave = false;
      return Promise.reject(new Error("simulated state-save failure"));
    }
    return super.saveState(state);
  }

  override saveSecret(secret: SecretRecord): Promise<void> {
    if (this.failNextSecretSave) {
      this.failNextSecretSave = false;
      return Promise.reject(new Error("simulated secret-save failure"));
    }
    return super.saveSecret(secret);
  }
}

async function unlockedFixture(
  state: WalletPublicState,
  now: () => number = Date.now,
): Promise<{
  repository: MemoryWalletRepository;
  service: WalletService;
  blake: MockEsplora;
  btc: MockEsplora;
}> {
  const repository = new MemoryWalletRepository(state);
  await repository.saveSecret(await encryptedSecret());
  const blake = new MockEsplora("blake");
  const btc = new MockEsplora("btc");
  const service = new WalletService(
    repository,
    (chain) => chain === "blake" ? blake : btc,
    now,
  );
  await service.initialize();
  await service.unlock(PASSWORD);
  return { repository, service, blake, btc };
}

function utxo(coin: PersistedCoin, confirmed = true): EsploraUtxo {
  return {
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    status: confirmed ? { confirmed: true, block_height: 961_645 } : { confirmed: false },
  };
}

function multiOutputFunding(): { rawTx: string; txid: string; values: [number, number] } {
  const values: [number, number] = [40_000, 70_000];
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  const source = FIXTURE_ADDRESSES[1];
  const transaction = new Transaction({ version: 2, lockTime: 900_000 });
  try {
    transaction.addInput({
      txid: "76".repeat(32),
      index: 1,
      sequence: RBF_SEQUENCE,
      witnessUtxo: {
        amount: 120_000n,
        script: fromHex(source.scriptPubKey),
      },
      tapInternalKey: keychain.internalPublicKey(source.path),
    });
    for (const value of values) {
      transaction.addOutput({
        amount: BigInt(value),
        script: fromHex(FIXTURE_ADDRESSES[0].scriptPubKey),
      });
    }
    const privateKey = keychain.privateKey(source.path);
    try {
      transaction.signIdx(
        privateKey,
        0,
        [SigHash.DEFAULT],
        crypto.getRandomValues(new Uint8Array(32)),
      );
    } finally {
      privateKey.fill(0);
    }
    transaction.finalize();
    return { rawTx: transaction.hex, txid: transaction.id, values };
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
}

Deno.test("wallet creation is serialized", async () => {
  const service = new WalletService(new MemoryWalletRepository());
  await service.initialize();
  const results = await Promise.allSettled([
    service.createWallet({ password: PASSWORD }),
    service.createWallet({ password: PASSWORD }),
  ]);
  if (results.filter((result) => result.status === "fulfilled").length !== 1) {
    throw new Error("Concurrent creation installed more than one wallet");
  }
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected || !String(rejected.reason).includes("already exists")) {
    throw new Error("The second concurrent creation did not fail cleanly");
  }
});

Deno.test("initialized public state without its encrypted secret is rejected", async () => {
  const service = new WalletService(new MemoryWalletRepository(baseState()));
  await assertRejects(
    () => service.initialize(),
    "wallet.json exists without its encrypted secret",
  );
});

Deno.test("wallet snapshots detach their receive address from service state", async () => {
  const repository = new MemoryWalletRepository(baseState());
  await repository.saveSecret(await encryptedSecret());
  const service = new WalletService(repository);
  const snapshot = await service.initialize();
  const originalAddress = snapshot.receiveAddress?.address;
  if (!snapshot.receiveAddress || !originalAddress) {
    throw new Error("Fixture did not expose its receive address");
  }

  snapshot.receiveAddress.address = "bc1ptampered";
  if (service.snapshot().receiveAddress?.address !== originalAddress) {
    throw new Error("Mutating a snapshot changed the authoritative receive address");
  }
});

Deno.test("failed secret persistence leaves wallet creation entirely uninstalled", async () => {
  const repository = new FailingMemoryWalletRepository();
  const service = new WalletService(repository);
  await service.initialize();
  repository.failNextSecretSave = true;

  await assertRejects(
    () => service.createWallet({ password: PASSWORD }),
    "simulated secret-save failure",
  );
  const snapshot = service.snapshot();
  if (
    snapshot.lockState !== "empty" || snapshot.addresses.length !== 0 ||
    snapshot.nextReceiveIndex !== 0 || await repository.loadSecret() !== null ||
    (await repository.loadState()).addresses.length !== 0
  ) {
    throw new Error("A wallet with no durable encrypted seed remained installed");
  }
});

Deno.test("failed public-state persistence keeps only a recoverable encrypted seed", async () => {
  const repository = new FailingMemoryWalletRepository();
  const service = new WalletService(repository);
  await service.initialize();
  repository.failNextStateSave = true;

  await assertRejects(
    () => service.createWallet({ password: PASSWORD }),
    "simulated state-save failure",
  );
  if (
    service.snapshot().lockState !== "empty" || service.snapshot().addresses.length !== 0 ||
    await repository.loadSecret() === null || (await repository.loadState()).addresses.length !== 0
  ) {
    throw new Error("A partially persisted wallet was exposed by the creating service");
  }

  const reopened = new WalletService(repository);
  if ((await reopened.initialize()).lockState !== "locked") {
    throw new Error("The durable encrypted seed was not available after restart");
  }
  const unlocked = await reopened.unlock(PASSWORD);
  const phrase = await reopened.recoveryPhrase();
  if (
    unlocked.lockState !== "unlocked" || unlocked.addresses[0]?.index !== 0 ||
    phrase.trim().split(/\s+/u).length !== 12
  ) {
    throw new Error("The encrypted seed could not reconstruct the interrupted wallet");
  }
});

Deno.test("unacknowledged recovery words survive a lost creation response", async () => {
  const repository = new MemoryWalletRepository();
  const creator = new WalletService(repository);
  await creator.initialize();
  const created = await creator.createWallet({ password: PASSWORD });
  if (created.snapshot.recoveryPhraseAcknowledged) {
    throw new Error("An unseen recovery phrase was marked acknowledged");
  }
  if (
    JSON.stringify(await repository.loadState()).includes(created.mnemonic) ||
    JSON.stringify(await repository.loadSecret()).includes(created.mnemonic)
  ) {
    throw new Error("The plaintext recovery phrase was persisted");
  }
  const reopened = new WalletService(repository);
  await reopened.initialize();
  await reopened.unlock(PASSWORD);
  if (await reopened.recoveryPhrase() !== created.mnemonic) {
    throw new Error("Encrypted entropy did not recover the pending phrase");
  }
  if (!(await reopened.acknowledgeRecoveryPhrase()).recoveryPhraseAcknowledged) {
    throw new Error("Recovery acknowledgement was not persisted");
  }
});

Deno.test("restoring an acknowledged recovery phrase does not echo it back", async () => {
  const service = new WalletService(new MemoryWalletRepository());
  await service.initialize();
  const restored = await service.restoreWallet({ mnemonic: RECOVERY, password: PASSWORD });
  if (restored.mnemonic !== "" || !restored.snapshot.recoveryPhraseAcknowledged) {
    throw new Error("Restore unnecessarily returned an already acknowledged recovery phrase");
  }
});

Deno.test("unlock re-derives persisted receive metadata and schedules recovery", async () => {
  const state = baseState();
  state.addresses[0] = {
    ...state.addresses[0],
    address: "bc1ptampered",
    scriptPubKey: `5120${"ff".repeat(32)}`,
  };
  const { repository, service } = await unlockedFixture(state);
  const snapshot = service.snapshot();
  const repaired = await repository.loadState();
  if (
    snapshot.receiveAddress !== undefined || snapshot.canCreateReceiveAddress ||
    snapshot.recoveryScanComplete ||
    repaired.addresses[0]?.address !== FIXTURE_ADDRESSES[0].address ||
    repaired.addresses[0]?.scriptPubKey !== FIXTURE_ADDRESSES[0].scriptPubKey
  ) {
    throw new Error("Unlock exposed an address before repairing and rescanning metadata");
  }
  await assertRejects(
    () => service.newReceiveAddress(),
    "Finish the recovery scan",
  );
});

Deno.test("receive address issuance stays inside the configured recovery gap", async () => {
  const state = baseState();
  state.settings.scanGap = 3;
  const { service } = await unlockedFixture(state);

  let snapshot = await service.newReceiveAddress();
  if (snapshot.receiveAddress?.index !== 1 || !snapshot.canCreateReceiveAddress) {
    throw new Error("Second unused receive address was not issued");
  }
  snapshot = await service.newReceiveAddress();
  if (snapshot.receiveAddress?.index !== 2 || snapshot.canCreateReceiveAddress) {
    throw new Error("Configured recovery gap did not close after three unused addresses");
  }
  await assertRejects(() => service.newReceiveAddress(), "recovery gap is full");
  await assertRejects(
    () => service.updateSettings({ scanGap: 2 }),
    "consecutive unused addresses already issued",
  );
});

Deno.test("manual receive issuance skips cached addresses with known history", async () => {
  const state = baseState();
  state.settings.scanGap = 1;
  state.addresses.push({ ...FIXTURE_ADDRESSES[1], used: true }, {
    ...FIXTURE_ADDRESSES[2],
  });
  const { service } = await unlockedFixture(state);

  if (!service.snapshot().canCreateReceiveAddress) {
    throw new Error("A used cached address did not reset the recovery gap");
  }
  const snapshot = await service.newReceiveAddress();
  if (snapshot.receiveAddress?.index !== 2 || snapshot.receiveAddress.used) {
    throw new Error("Manual issuance displayed a cached address with known history");
  }
});

Deno.test("failed state saves do not leak rejected changes into live state", async () => {
  const repository = new FailingMemoryWalletRepository(baseState());
  await repository.saveSecret(await encryptedSecret());
  const blake = new MockEsplora("blake");
  const btc = new MockEsplora("btc");
  const service = new WalletService(
    repository,
    (chain) => chain === "blake" ? blake : btc,
  );
  await service.initialize();
  await service.unlock(PASSWORD);

  repository.failNextStateSave = true;
  await assertRejects(
    () => service.updateSettings({ amountUnit: "sat" }),
    "simulated state-save failure",
  );
  if (service.snapshot().settings.amountUnit !== "btc") {
    throw new Error("Rejected settings remained active in memory");
  }

  repository.failNextStateSave = true;
  await assertRejects(() => service.newReceiveAddress(), "simulated state-save failure");
  if (
    service.snapshot().nextReceiveIndex !== 1 ||
    service.snapshot().receiveAddress?.index !== 0
  ) {
    throw new Error("Rejected address issuance remained active in memory");
  }

  await service.updateSettings({ btcFeeRate: 2 });
  const persisted = await repository.loadState();
  if (
    persisted.settings.amountUnit !== "btc" || persisted.nextReceiveIndex !== 1 ||
    persisted.settings.btcFeeRate !== 2
  ) {
    throw new Error("A later save persisted an earlier rejected change");
  }
});

Deno.test("settings enforce independent fee ceilings, URLs, units, and gap rescan", async () => {
  const state = baseState();
  state.addresses = Array.from({ length: 10 }, (_, index) => ({
    ...FIXTURE_ADDRESSES[0],
    path: `m/86'/0'/0'/0/${index}`,
    index,
    used: false,
  }));
  const repository = new MemoryWalletRepository(state);
  await repository.saveSecret(await encryptedSecret());
  const service = new WalletService(repository);
  await service.initialize();
  let snapshot = await service.updateSettings({
    btcFeeRate: 100,
    blakeFeeRate: 99.9,
    amountUnit: "sat",
    btcConfirmations: 2,
    blakeConfirmations: 6,
  });
  if (
    snapshot.settings.btcFeeRate !== 100 || snapshot.settings.blakeFeeRate !== 99.9 ||
    snapshot.settings.amountUnit !== "sat" ||
    snapshot.settings.btcConfirmations !== 2 || snapshot.settings.blakeConfirmations !== 6
  ) throw new Error("Current settings were not preserved exactly");
  for (const update of [{ btcFeeRate: 100.1 }, { blakeFeeRate: 100.1 }]) {
    await assertRejects(() => service.updateSettings(update), "100 sat/vB");
  }
  for (const key of ["btcConfirmations", "blakeConfirmations"] as const) {
    for (const value of [-1, 1_001, 1.5, NaN, "1", null]) {
      await assertRejects(
        () => service.updateSettings({ [key]: value }),
        "confirmations must be an integer",
      );
    }
  }
  await assertRejects(
    () => service.updateSettings({ btcApiUrl: "http://example.com/api" }),
    "only on localhost",
  );
  await assertRejects(
    () => service.updateSettings({ btcApiUrl: "https://example.com/api?token=secret" }),
    "credentials or query parameters",
  );
  snapshot = await service.updateSettings({ scanGap: 20 });
  if (
    snapshot.recoveryScanComplete || snapshot.recoveryScan?.nextIndex !== 10 ||
    snapshot.recoveryScan.trailingGap !== 10
  ) throw new Error("Increasing the gap did not restart recovery");
});

Deno.test("BIP177 is a persisted display choice and does not change coin values", async () => {
  const funding = coin("10".repeat(32), 100_000_000, FIXTURE_ADDRESSES[0], true, true);
  const { repository, service } = await unlockedFixture(baseState([funding]));
  const original = await repository.loadState();
  const balances = service.snapshot().balances;
  for (const amountUnit of ["bip177", "sat", "btc"] as const) {
    const snapshot = await service.updateSettings({ amountUnit });
    if (
      snapshot.settings.amountUnit !== amountUnit ||
      JSON.stringify(snapshot.balances) !== JSON.stringify(balances)
    ) throw new Error("Changing the display unit changed the balance or did not take effect");
    const persisted = parseWalletState(await repository.loadState());
    if (
      JSON.stringify(persisted) !== JSON.stringify({
        ...original,
        settings: { ...original.settings, amountUnit },
      })
    ) throw new Error("Changing the display unit changed other wallet state");
    const reopened = new WalletService(repository);
    if ((await reopened.initialize()).settings.amountUnit !== amountUnit) {
      throw new Error("Reopening the wallet lost the display unit");
    }
  }
  await assertRejects(
    () => service.updateSettings({ amountUnit: "bitcoin" as never }),
    "Invalid amount denomination",
  );
});

Deno.test("manual full rescan restarts discovery without discarding cached safety state", async () => {
  const retained = coin("10".repeat(32), 50_000, FIXTURE_ADDRESSES[0], true, true);
  const state = baseState([retained]);
  state.settings.scanGap = 30;
  state.sharedProvenance[retained.outpoint] = { firstObservedAt: new Date().toISOString() };
  const { repository, service, blake, btc } = await unlockedFixture(state);

  const snapshot = await service.fullRescan();
  const persisted = await repository.loadState();
  if (
    snapshot.recoveryScanComplete || snapshot.recoveryScan?.nextIndex !== 25 ||
    snapshot.recoveryScan.trailingGap !== 25 || snapshot.lastSyncAt !== undefined ||
    blake.addressRequests !== 25 || btc.addressRequests !== 25 ||
    !persisted.coins.some((candidate) => candidate.outpoint === retained.outpoint) ||
    !persisted.sharedProvenance[retained.outpoint]
  ) {
    throw new Error("Full rescan did not safely restart address discovery from index 0");
  }
});

Deno.test("cached coins remain selectable while stale observations produce a warning", async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  const cached = coin("11".repeat(32), 50_000, FIXTURE_ADDRESSES[0], true, false);
  cached.blake.checkedAt = stale;
  cached.btc.checkedAt = stale;
  const state = baseState([cached]);
  state.lastSyncAt = stale;
  const repository = new MemoryWalletRepository(state);
  await repository.saveSecret(await encryptedSecret());
  const service = new WalletService(repository);
  const snapshot = await service.initialize();
  if (
    !snapshot.selectableBlakeOutpoints.includes(cached.outpoint) ||
    !snapshot.warnings.some((warning) => warning.includes("stale"))
  ) throw new Error("Cached selection or stale warning was lost");
});

Deno.test("partial coin scans do not claim a fresh synchronization", async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  const cached = coin("12".repeat(32), 50_000, FIXTURE_ADDRESSES[0], true, false);
  cached.blake.checkedAt = stale;
  cached.btc.checkedAt = stale;
  const state = baseState([cached]);
  state.lastSyncAt = stale;
  const { service, blake } = await unlockedFixture(state);
  blake.utxoFailure = new Error("temporary UTXO failure");

  const snapshot = await service.sync();
  if (
    snapshot.lastSyncAt !== stale ||
    !snapshot.lastSyncError?.includes("temporary UTXO failure") ||
    !snapshot.warnings.some((warning) => warning.includes("stale"))
  ) {
    throw new Error("A partial coin scan was presented as a fresh synchronization");
  }
});

Deno.test("BTC coin observations update when the BLAKE UTXO scan fails", async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  const cached = coin("13".repeat(32), 50_000, FIXTURE_ADDRESSES[0], true, true);
  const arrivedOnBtc = coin("15".repeat(32), 30_000, FIXTURE_ADDRESSES[0], false, true);
  const state = baseState([cached]);
  state.lastSyncAt = stale;
  state.sharedProvenance[cached.outpoint] = { firstObservedAt: stale };
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxoFailure = new Error("temporary BLAKE UTXO failure");
  btc.utxos.set(cached.address, [utxo(arrivedOnBtc)]);

  const snapshot = await service.sync();
  const persisted = await repository.loadState();
  const retained = persisted.coins.find((candidate) => candidate.outpoint === cached.outpoint);
  const discovered = persisted.coins.find((candidate) =>
    candidate.outpoint === arrivedOnBtc.outpoint
  );
  if (
    snapshot.balances.blake !== cached.value || snapshot.balances.btc !== arrivedOnBtc.value ||
    retained?.blake.unspent !== true || retained.btc.unspent !== false ||
    discovered?.btc.unspent !== true || discovered.blake.backendOk !== false ||
    snapshot.lastSyncAt !== stale ||
    !snapshot.lastSyncError?.includes("temporary BLAKE UTXO failure")
  ) {
    throw new Error("The successful BTC scan was not installed independently");
  }
});

Deno.test("BTC coin observations update when the BLAKE tip request fails", async () => {
  const arrivedOnBtc = coin("16".repeat(32), 25_000, FIXTURE_ADDRESSES[0], false, true);
  const { service, blake, btc } = await unlockedFixture(baseState());
  blake.tipFailure = new Error("temporary BLAKE tip failure");
  btc.utxos.set(arrivedOnBtc.address, [utxo(arrivedOnBtc)]);

  const snapshot = await service.sync();
  if (
    snapshot.balances.btc !== arrivedOnBtc.value || snapshot.balances.blake !== 0 ||
    !snapshot.lastSyncError?.includes("temporary BLAKE tip failure")
  ) {
    throw new Error("A failed BLAKE tip prevented the successful BTC scan");
  }
});

Deno.test("partial outpoint mismatches preserve cached chain observations", async () => {
  const cached = coin("14".repeat(32), 50_000, FIXTURE_ADDRESSES[0], true, true);
  const state = baseState([cached]);
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(cached.address, [utxo(cached)]);
  btc.utxos.set(cached.address, [{ ...utxo(cached), value: cached.value + 1 }]);

  const snapshot = await service.sync();
  const persisted = await repository.loadState();
  const stored = persisted.coins.find((candidate) => candidate.outpoint === cached.outpoint);
  if (
    snapshot.balances.blake !== cached.value || snapshot.balances.btc !== cached.value ||
    !snapshot.lastSyncError?.includes(`Backend mismatch for ${cached.outpoint}`) ||
    JSON.stringify(stored?.btc) !== JSON.stringify(cached.btc)
  ) {
    throw new Error("A rejected partial observation overwrote the cached chain state");
  }
});

async function assertRejects(operation: () => Promise<unknown>, expected: string): Promise<void> {
  let message = "";
  try {
    await operation();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(expected)) {
    throw new Error(`Expected rejection containing "${expected}", received "${message}"`);
  }
}

Deno.test("sync installs the dual-chain union, ignores zero outputs, and retains provenance", async () => {
  const state = baseState();
  const { service, blake, btc } = await unlockedFixture(state);
  const shared = coin("21".repeat(32), 40_000, FIXTURE_ADDRESSES[0], true, true);
  const btcOnly = coin("22".repeat(32), 30_000, FIXTURE_ADDRESSES[0], false, true);
  blake.utxos.set(FIXTURE_ADDRESSES[0].address, [
    utxo(shared),
    { ...utxo(shared), txid: "23".repeat(32), value: 0 },
  ]);
  btc.utxos.set(FIXTURE_ADDRESSES[0].address, [utxo(shared), utxo(btcOnly)]);
  let snapshot = await service.sync();
  if (
    snapshot.outputs.length !== 2 || snapshot.balances.blake !== shared.value ||
    snapshot.balances.btc !== shared.value + btcOnly.value ||
    !snapshot.splittableOutpoints.includes(shared.outpoint) ||
    !snapshot.replayCandidateTxids.includes(btcOnly.txid)
  ) throw new Error("Sync did not install the expected chain union");

  blake.utxos.set(FIXTURE_ADDRESSES[0].address, []);
  btc.utxos.set(FIXTURE_ADDRESSES[0].address, []);
  snapshot = await service.sync();
  const persisted = await (service.repository as MemoryWalletRepository).loadState();
  if (
    snapshot.outputs.some((output) => output.outpoint === btcOnly.outpoint) ||
    !snapshot.outputs.some((output) => output.outpoint === shared.outpoint) ||
    !persisted.sharedProvenance[shared.outpoint]
  ) {
    throw new Error("Authoritative sync did not retain only the shared provenance tombstone");
  }
});

Deno.test("sync retains shared provenance across separate chain observations", async () => {
  const firstSeenOnBtc = coin("26".repeat(32), 40_000, FIXTURE_ADDRESSES[0], false, true);
  const firstSeenOnBlake = coin("27".repeat(32), 30_000, FIXTURE_ADDRESSES[0], true, false);
  const { repository, service, blake, btc } = await unlockedFixture(
    baseState([firstSeenOnBtc, firstSeenOnBlake]),
  );
  blake.utxos.set(FIXTURE_ADDRESSES[0].address, [utxo(firstSeenOnBtc)]);
  btc.utxos.set(FIXTURE_ADDRESSES[0].address, [utxo(firstSeenOnBlake)]);

  const snapshot = await service.sync();
  const persisted = await repository.loadState();
  for (const output of [firstSeenOnBtc, firstSeenOnBlake]) {
    if (
      !persisted.sharedProvenance[output.outpoint] ||
      !snapshot.outputs.find((candidate) => candidate.outpoint === output.outpoint)?.wasShared
    ) {
      throw new Error("A prior observation on the other chain lost shared provenance");
    }
  }
});

Deno.test("targeted intent refresh includes replay parents of a protecting split", async () => {
  const parentId = "00000000-0000-4000-8000-000000000090";
  const splitId = "00000000-0000-4000-8000-000000000091";
  const parentOutpoint = `${"28".repeat(32)}:0`;
  const selectedOutpoint = `${"29".repeat(32)}:0`;
  const state = emptyPublicState();
  state.intents = [{
    id: parentId,
    kind: "blake-replay",
    chain: "blake",
    txid: "2a".repeat(32),
    rawTx: "00",
    createdAt: new Date().toISOString(),
    phase: "confirmed",
    broadcastStartedAt: new Date().toISOString(),
    walletInputOutpoints: [],
    walletOutpoints: [parentOutpoint],
  }, {
    id: splitId,
    kind: "blake-unified",
    chain: "blake",
    txid: "2b".repeat(32),
    rawTx: "00",
    createdAt: new Date().toISOString(),
    phase: "confirmed",
    broadcastStartedAt: new Date().toISOString(),
    inputOutpoints: [parentOutpoint, selectedOutpoint],
    sharedOutpoints: [parentOutpoint, selectedOutpoint],
    parentReplayIntentIds: [parentId],
  }];
  const blake = new MockEsplora("blake");
  const btc = new MockEsplora("btc");
  blake.statuses.set("2b".repeat(32), { confirmed: true, block_height: 961_649 });
  const errors: string[] = [];

  await new IntentReconciler(() => state).refreshStatuses(
    { blake, btc },
    { blake: blake.tip, btc: btc.tip },
    errors,
    new Set([selectedOutpoint]),
  );

  if (state.intents[0].phase !== "recoverable" || errors.length > 0) {
    throw new Error("A targeted validation left its replay-dependent protection stale");
  }
});

Deno.test("sync rotates the receive address after either chain confirms a deposit", async () => {
  const { repository, service, blake, btc } = await unlockedFixture(baseState());
  const first = coin("24".repeat(32), 20_000, FIXTURE_ADDRESSES[0], false, true, false);
  btc.utxos.set(first.address, [utxo(first, false)]);

  let snapshot = await service.sync();
  if (snapshot.receiveAddress?.index !== 0) {
    throw new Error("An unconfirmed deposit rotated the receive address");
  }

  btc.utxos.set(first.address, [utxo(first)]);
  snapshot = await service.sync();
  const secondAddress = snapshot.receiveAddress;
  if (secondAddress?.index !== 1) {
    throw new Error("A confirmed Bitcoin deposit did not rotate the receive address");
  }

  const second = coin("25".repeat(32), 30_000, secondAddress, true, false);
  blake.utxos.set(second.address, [utxo(second)]);
  snapshot = await service.sync();
  const persisted = await repository.loadState();
  if (
    snapshot.receiveAddress?.index !== 2 ||
    !persisted.addresses.some((address) => address.index === 0 && address.used) ||
    !persisted.addresses.some((address) => address.index === 1 && address.used) ||
    blake.addressRequests !== 0 || btc.addressRequests !== 0
  ) {
    throw new Error("Either-chain rotation lost an old address or added an address-info request");
  }
});

Deno.test("sync is rejected while locked and rotates normally after unlock", async () => {
  const { repository, service, btc } = await unlockedFixture(baseState());
  const deposit = coin("2c".repeat(32), 20_000, FIXTURE_ADDRESSES[0], false, true);
  btc.utxos.set(deposit.address, [utxo(deposit)]);
  await service.lock();
  const before = await repository.loadState();

  await assertRejects(() => service.sync(), "Unlock the wallet first");
  if (JSON.stringify(await repository.loadState()) !== JSON.stringify(before)) {
    throw new Error("A locked synchronization mutated wallet state");
  }

  await service.unlock(PASSWORD);
  const snapshot = await service.sync();
  if (snapshot.receiveAddress?.index !== 1) {
    throw new Error("The confirmed deposit did not rotate after unlocking and syncing");
  }
});

Deno.test("automatic receive rotation skips cached addresses with known history", async () => {
  const state = baseState();
  state.addresses.push({ ...FIXTURE_ADDRESSES[1], used: true }, {
    ...FIXTURE_ADDRESSES[2],
  });
  const { service, btc } = await unlockedFixture(state);
  const deposit = coin("2e".repeat(32), 25_000, FIXTURE_ADDRESSES[0], false, true);
  btc.utxos.set(FIXTURE_ADDRESSES[0].address, [utxo(deposit)]);

  const snapshot = await service.sync();
  if (snapshot.receiveAddress?.index !== 2 || snapshot.receiveAddress.used) {
    throw new Error("Automatic rotation displayed a cached address with known history");
  }
});

Deno.test("routine sync monitors restored unused lookahead addresses", async () => {
  const state = baseState();
  state.addresses.push({ ...FIXTURE_ADDRESSES[1] });
  const { repository, service, btc } = await unlockedFixture(state);
  const delayed = coin("2f".repeat(32), 25_000, FIXTURE_ADDRESSES[1], false, true);
  btc.utxos.set(FIXTURE_ADDRESSES[1].address, [utxo(delayed)]);

  const snapshot = await service.sync();
  const persisted = await repository.loadState();
  if (
    !snapshot.outputs.some((output) => output.outpoint === delayed.outpoint) ||
    !persisted.addresses.some((address) => address.index === 1 && address.used)
  ) {
    throw new Error("A delayed payment to a restored lookahead address was not discovered");
  }
});

Deno.test("a confirmed child spend advances an address whose zero-conf deposit was spent", async () => {
  const deposit = coin("26".repeat(32), 50_000, FIXTURE_ADDRESSES[0], false, true, false);
  const state = baseState([deposit]);
  state.settings.btcConfirmations = 0;
  state.settings.blakeConfirmations = 0;
  const { service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(deposit.address, []);
  btc.utxos.set(deposit.address, [utxo(deposit, false)]);

  let snapshot = await service.sync();
  if (snapshot.receiveAddress?.index !== 0) {
    throw new Error("An unconfirmed deposit rotated the receive address");
  }
  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [deposit.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const spend = await service.confirmSpend(preview.id, false, true);

  btc.utxos.set(deposit.address, []);
  btc.statuses.set(spend.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "27".repeat(32),
  });
  snapshot = await service.sync();
  if (snapshot.receiveAddress?.index !== 1) {
    throw new Error("Confirmed child spend did not advance the spent deposit address");
  }
});

Deno.test("BTC spend persists before broadcast and remains recoverable across confirmation and reorg", async () => {
  const source = coin("31".repeat(32), 90_000, FIXTURE_ADDRESSES[0], false, true);
  const state = baseState([source]);
  let clock = Date.now();
  const { repository, service, blake, btc } = await unlockedFixture(state, () => clock);
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source)]);

  const canceled = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  await service.cancelSpendPreview(canceled.id);
  await assertRejects(() => service.confirmSpend(canceled.id), "missing or was already used");

  const expired = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  clock += 5 * 60 * 1_000 + 1;
  await assertRejects(() => service.confirmSpend(expired.id), "expired");

  const malformed = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  blake.malformedUtxos = true;
  await assertRejects(() => service.confirmSpend(malformed.id, false, true), "malformed UTXO");
  blake.malformedUtxos = false;
  if (btc.broadcasts.length > 0) {
    throw new Error("Malformed final observations allowed a broadcast");
  }

  const staleLocktime = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  btc.tip--;
  await assertRejects(
    () => service.confirmSpend(staleLocktime.id, false, true),
    "review the spend again",
  );
  if (
    service.snapshot().tips.btc?.height !== btc.tip ||
    (await repository.loadState()).tips.btc?.height !== btc.tip
  ) throw new Error("A lowered final tip was not persisted");

  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (preview.risks[0]?.kind !== "possible-funding-replay") {
    throw new Error("BTC-only spend did not expose uncertain funding replayability");
  }
  let intentSeenBeforePost = false;
  btc.beforeBroadcast = async (rawTx) => {
    const persisted = await repository.loadState();
    const intent = persisted.intents.find((candidate) => candidate.rawTx === rawTx);
    intentSeenBeforePost = intent?.kind === "btc-spend" &&
      intent.phase === "broadcast-unknown" && Boolean(intent.broadcastStartedAt);
  };
  const result = await service.confirmSpend(preview.id, false, true);
  const decoded = RawTx.decode(fromHex(result.rawTx)) as { witnesses?: Uint8Array[][] };
  if (
    !intentSeenBeforePost || result.chain !== "btc" || result.action !== "send" ||
    decoded.witnesses?.[0]?.[0]?.length !== 64 || blake.broadcasts.length !== 0 ||
    btc.broadcasts.length !== 1
  ) throw new Error("BTC signing or durable broadcast sequencing was incorrect");
  let snapshot = service.snapshot();
  let intent = snapshot.intents.find((candidate) => candidate.txid === result.txid);
  if (
    intent?.kind !== "btc-spend" || intent.phase !== "seen" ||
    snapshot.selectableBtcOutpoints.includes(source.outpoint)
  ) throw new Error("Broadcast BTC intent did not govern its input");
  const intentId = intent.id;
  parseWalletState(JSON.parse(JSON.stringify(await repository.loadState())));

  btc.utxos.set(source.address, []);
  btc.statuses.set(result.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "41".repeat(32),
  });
  snapshot = await service.sync();
  intent = snapshot.intents.find((candidate) => candidate.id === intentId);
  if (intent?.phase !== "confirmed") throw new Error("Confirmed BTC intent was not retained");

  btc.utxos.set(source.address, [utxo(source)]);
  btc.statuses.set(result.txid, null);
  snapshot = await service.sync();
  intent = snapshot.intents.find((candidate) => candidate.id === intentId);
  if (
    intent?.phase !== "recoverable" || !intent.canRebroadcast || !intent.canAbandon ||
    snapshot.selectableBtcOutpoints.includes(source.outpoint)
  ) throw new Error("Reorged BTC spend was not held for explicit recovery");
  parseWalletState(JSON.parse(JSON.stringify(await repository.loadState())));

  snapshot = await service.abandonIntent(intentId);
  intent = snapshot.intents.find((candidate) => candidate.id === intentId);
  if (
    intent?.phase !== "abandoned" ||
    !snapshot.selectableBtcOutpoints.includes(source.outpoint)
  ) throw new Error("Verified abandonment did not release the restored BTC input");
  parseWalletState(JSON.parse(JSON.stringify(await repository.loadState())));
});

Deno.test("ambiguous broadcast failure retains the exact signed transaction for rebroadcast", async () => {
  const source = coin("42".repeat(32), 75_000, FIXTURE_ADDRESSES[0], false, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([source]));
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source)]);
  btc.broadcastFailure = new Error("connection closed after POST");
  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  await assertRejects(
    () => service.confirmSpend(preview.id, false, true),
    "connection closed after POST",
  );
  let snapshot = service.snapshot();
  const uncertain = snapshot.intents.find((intent) => intent.phase === "broadcast-unknown");
  const persisted = (await repository.loadState()).intents.find((intent) =>
    intent.txid === uncertain?.txid
  );
  if (
    !uncertain?.canRebroadcast || !persisted?.rawTx ||
    snapshot.selectableBtcOutpoints.includes(source.outpoint)
  ) throw new Error("Ambiguous POST outcome was treated as a safe rejection");

  btc.broadcastFailure = null;
  const result = await service.rebroadcastIntent(uncertain.id);
  snapshot = service.snapshot();
  if (
    result.rawTx !== persisted.rawTx ||
    snapshot.intents.find((intent) => intent.id === uncertain.id)?.phase !== "seen"
  ) throw new Error("Recovery did not rebroadcast the identical signed transaction");
});

Deno.test("an abandoned BTC spend can be retried with the same txid and a new intent", async () => {
  const source = coin("43".repeat(32), 75_000, FIXTURE_ADDRESSES[0], false, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([source]));
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source)]);
  btc.broadcastFailure = new Error("connection closed after POST");

  const firstPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  await assertRejects(
    () => service.confirmSpend(firstPreview.id, false, true),
    "connection closed after POST",
  );

  const snapshot = await service.sync();
  const firstIntent = snapshot.intents.find((intent) => intent.kind === "btc-spend");
  if (firstIntent?.phase !== "recoverable" || !firstIntent.canAbandon) {
    throw new Error("Failed BTC broadcast did not become recoverable");
  }
  await service.abandonIntent(firstIntent.id);

  btc.broadcastFailure = null;
  const secondPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const result = await service.confirmSpend(secondPreview.id, false, true);
  const attempts = (await repository.loadState()).intents.filter((intent) =>
    intent.kind === "btc-spend" && intent.txid === result.txid
  );
  if (
    attempts.length !== 2 || attempts[0].id === attempts[1].id ||
    attempts[0].rawTx === attempts[1].rawTx || attempts[0].phase !== "abandoned" ||
    attempts[1].phase !== "seen"
  ) {
    throw new Error("Same-txid BTC retry did not retain two independent signed attempts");
  }
});

Deno.test("a resurfaced BTC spend supersedes its conflicting replacement", async () => {
  const source = coin("44".repeat(32), 75_000, FIXTURE_ADDRESSES[0], false, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([source]));
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source)]);

  const firstPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const first = await service.confirmSpend(firstPreview.id, false, true);
  btc.statuses.set(first.txid, null);
  let snapshot = await service.sync();
  const firstIntent = snapshot.intents.find((intent) => intent.txid === first.txid);
  if (firstIntent?.phase !== "recoverable") {
    throw new Error("First BTC spend did not become recoverable");
  }
  await service.abandonIntent(firstIntent.id);

  const replacementPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 3,
  });
  const replacement = await service.confirmSpend(replacementPreview.id, false, true);
  if (replacement.txid === first.txid) throw new Error("Replacement did not change the txid");
  const replacementIntent = (await repository.loadState()).intents.find((intent) =>
    intent.kind === "btc-spend" && intent.txid === replacement.txid
  );
  if (!replacementIntent) throw new Error("Replacement BTC intent is missing");

  btc.utxos.set(source.address, []);
  btc.statuses.set(first.txid, { confirmed: false });
  btc.statuses.set(replacement.txid, null);
  snapshot = await service.sync();
  if (
    snapshot.lastSyncError ||
    snapshot.intents.find((intent) => intent.id === firstIntent.id)?.phase !== "seen" ||
    snapshot.intents.find((intent) => intent.id === replacementIntent.id)?.phase !== "abandoned"
  ) {
    throw new Error("Resurfaced original spend did not supersede its absent replacement");
  }

  btc.statuses.set(first.txid, null);
  btc.statuses.set(replacement.txid, { confirmed: false });
  snapshot = await service.sync();
  if (
    snapshot.lastSyncError ||
    snapshot.intents.find((intent) => intent.id === firstIntent.id)?.phase !== "abandoned" ||
    snapshot.intents.find((intent) => intent.id === replacementIntent.id)?.phase !== "seen"
  ) {
    throw new Error("Replacement did not become active when the backend winner changed");
  }
  parseWalletState(JSON.parse(JSON.stringify(await repository.loadState())));
});

Deno.test("a resurfaced exposed spend retains its input for receive rotation", async () => {
  const source = coin("46".repeat(32), 75_000, FIXTURE_ADDRESSES[0], false, true, false);
  const state = baseState([source]);
  state.settings.btcConfirmations = 0;
  state.settings.blakeConfirmations = 0;
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source, false)]);

  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const result = await service.confirmSpend(preview.id, false, true);
  btc.statuses.set(result.txid, null);
  let snapshot = await service.sync();
  const intent = snapshot.intents.find((candidate) => candidate.txid === result.txid);
  if (intent?.phase !== "recoverable") {
    throw new Error("Missing exposed spend did not become recoverable");
  }
  await service.abandonIntent(intent.id);

  btc.utxos.set(source.address, []);
  btc.statuses.set(result.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "47".repeat(32),
  });
  snapshot = await service.sync();
  const persisted = await repository.loadState();
  if (
    snapshot.intents.find((candidate) => candidate.id === intent.id)?.phase !== "confirmed" ||
    !persisted.coins.some((coin) => coin.outpoint === source.outpoint) ||
    snapshot.receiveAddress?.index !== 1
  ) {
    throw new Error("A resurfaced abandoned spend lost its input metadata or address rotation");
  }
});

Deno.test("BTC final validation records a funding transaction already present on the fork", async () => {
  const source = coin("47".repeat(32), 80_000, FIXTURE_ADDRESSES[0], false, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([source]));
  blake.utxos.set(source.address, []);
  btc.utxos.set(source.address, [utxo(source)]);
  blake.statuses.set(source.txid, {
    confirmed: true,
    block_height: 961_645,
    block_hash: "48".repeat(32),
  });
  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [source.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  await assertRejects(() => service.confirmSpend(preview.id, false, true), "risk changed");
  if (
    !(await repository.loadState()).sharedProvenance[source.outpoint] ||
    !service.snapshot().selectableBtcOutpoints.includes(source.outpoint) ||
    btc.broadcasts.length > 0
  ) throw new Error("Existing fork funding did not require a fresh replay-risk review");
});

Deno.test("BLAKE confirmation compares the exact shared inputs shown in its preview", async () => {
  const first = coin("49".repeat(32), 80_000, FIXTURE_ADDRESSES[0], true, true);
  const second = coin("50".repeat(32), 60_000, FIXTURE_ADDRESSES[0], true, false);
  const { service, blake, btc } = await unlockedFixture(baseState([first, second]));
  blake.utxos.set(first.address, [utxo(first), utxo(second)]);
  btc.utxos.set(first.address, [utxo(first)]);

  const preview = await service.previewSpend({
    chain: "blake",
    purpose: "send",
    outpoints: [first.outpoint, second.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (
    preview.splitInputCount !== 1 || preview.splitOutpoints[0] !== first.outpoint
  ) throw new Error("Preview did not retain the exact shared input");

  btc.utxos.set(first.address, [utxo(second)]);
  await assertRejects(
    () => service.confirmSpend(preview.id),
    "Split state changed during final validation",
  );
  if (blake.broadcasts.length > 0) {
    throw new Error("BLAKE spend was signed after its shared inputs changed identity");
  }
});

Deno.test("mixed BLAKE spend records the exact shared subset and recovers after reorg", async () => {
  const shared = coin("51".repeat(32), 80_000, FIXTURE_ADDRESSES[0], true, true);
  const blakeOnly = coin("52".repeat(32), 60_000, FIXTURE_ADDRESSES[0], true, false);
  const { repository, service, blake, btc } = await unlockedFixture(
    baseState([shared, blakeOnly]),
  );
  blake.utxos.set(shared.address, [utxo(shared), utxo(blakeOnly)]);
  btc.utxos.set(shared.address, [utxo(shared)]);

  const preview = await service.previewSpend({
    chain: "blake",
    purpose: "send",
    outpoints: [shared.outpoint, blakeOnly.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (preview.purpose !== "split" || preview.splitInputCount !== 1) {
    throw new Error("Mixed BLAKE spend did not identify its one shared input");
  }
  let durableBeforePost = false;
  blake.beforeBroadcast = async (rawTx) => {
    const persisted = await repository.loadState();
    const intent = persisted.intents.find((candidate) => candidate.rawTx === rawTx);
    durableBeforePost = intent?.kind === "blake-unified" &&
      intent.phase === "broadcast-unknown" &&
      intent.inputOutpoints.length === 2 &&
      intent.sharedOutpoints.length === 1 &&
      intent.sharedOutpoints[0] === shared.outpoint;
  };
  const result = await service.confirmSpend(preview.id);
  const decoded = RawTx.decode(fromHex(result.rawTx)) as { witnesses?: Uint8Array[][] };
  if (
    !durableBeforePost || result.action !== "split" || result.chain !== "blake" ||
    decoded.witnesses?.length !== 2 ||
    decoded.witnesses.some((stack) => stack[0]?.length !== 65 || stack[0]?.at(-1) !== 0x21) ||
    btc.broadcasts.length !== 0
  ) throw new Error("Unified mixed-input transaction was not signed or persisted safely");
  const persisted = await repository.loadState();
  const stored = persisted.intents.find((intent) => intent.txid === result.txid);
  if (
    stored?.kind !== "blake-unified" ||
    stored.sharedOutpoints[0] !== shared.outpoint ||
    persisted.sharedProvenance[blakeOnly.outpoint]
  ) throw new Error("BLAKE-only input was incorrectly promoted to shared provenance");
  const splitIntentId = stored.id;

  blake.utxos.set(shared.address, []);
  btc.utxos.set(shared.address, [utxo(shared)]);
  blake.statuses.set(result.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "53".repeat(32),
  });
  let snapshot = await service.sync();
  let summary = snapshot.intents.find((intent) => intent.id === splitIntentId);
  if (
    summary?.phase !== "confirmed" ||
    !snapshot.selectableBtcOutpoints.includes(shared.outpoint)
  ) throw new Error("Confirmed split did not release its BTC copy");

  blake.statusFailure = new Error("temporary status failure");
  snapshot = await service.sync();
  summary = snapshot.intents.find((intent) => intent.id === splitIntentId);
  if (
    summary?.phase !== "broadcast-unknown" ||
    !snapshot.selectableBtcOutpoints.includes(shared.outpoint)
  ) throw new Error("Failed confirmation revalidation did not expose an explicit-risk BTC path");
  const uncertainBtc = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (uncertainBtc.risks[0]?.splitIntentIds[0] !== splitIntentId) {
    throw new Error("Uncertain split status lost its related replay-risk transaction");
  }
  await service.cancelSpendPreview(uncertainBtc.id);
  blake.statusFailure = null;
  snapshot = await service.sync();
  if (
    snapshot.intents.find((intent) => intent.id === splitIntentId)?.phase !== "confirmed"
  ) throw new Error("Split confirmation did not recover after backend availability returned");

  blake.utxos.set(shared.address, [utxo(shared), utxo(blakeOnly)]);
  blake.statuses.set(result.txid, null);
  snapshot = await service.sync();
  summary = snapshot.intents.find((intent) => intent.id === splitIntentId);
  if (
    summary?.phase !== "recoverable" || !summary.canRebroadcast || !summary.canAbandon ||
    snapshot.selectableBtcOutpoints.includes(shared.outpoint) ||
    snapshot.selectableBlakeOutpoints.includes(blakeOnly.outpoint)
  ) throw new Error("Reorged unified spend did not fail closed");

  await service.rebroadcastIntent(splitIntentId);
  if (blake.broadcasts.length !== 2) throw new Error("Unified intent did not rebroadcast exactly");
  blake.statuses.set(result.txid, null);
  snapshot = await service.abandonIntent(splitIntentId);
  summary = snapshot.intents.find((intent) => intent.id === splitIntentId);
  if (
    summary?.phase !== "abandoned" ||
    !snapshot.selectableBlakeOutpoints.includes(shared.outpoint) ||
    !snapshot.selectableBlakeOutpoints.includes(blakeOnly.outpoint)
  ) throw new Error("Abandoning a restored mixed spend did not release both BLAKE inputs");
});

Deno.test("unsplit shared BTC spend requires an independent replay acknowledgement", async () => {
  const shared = coin("60".repeat(32), 100_000, FIXTURE_ADDRESSES[0], true, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([shared]));
  blake.utxos.set(shared.address, [utxo(shared)]);
  btc.utxos.set(shared.address, [utxo(shared)]);
  let snapshot = await service.sync();
  if (!snapshot.selectableBtcOutpoints.includes(shared.outpoint)) {
    throw new Error("Unsplit shared BTC input was not selectable");
  }
  const preview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (
    preview.risks.length !== 1 || preview.risks[0].kind !== "shared-coin-replay" ||
    preview.risks[0].splitIntentIds.length !== 0
  ) throw new Error("Unsplit BTC preview did not expose its replay risk");
  await assertRejects(
    () => service.confirmSpend(preview.id, false, false),
    "replay risk requires explicit confirmation",
  );
  let acknowledgementPersisted = false;
  btc.beforeBroadcast = async (rawTx) => {
    const state = await repository.loadState();
    const intent = state.intents.find((candidate) => candidate.rawTx === rawTx);
    acknowledgementPersisted = intent?.kind === "btc-spend" &&
      intent.phase === "broadcast-unknown" &&
      intent.replayRisk?.kinds[0] === "shared-coin-replay" &&
      intent.replayRisk.splitIntentIds.length === 0;
  };
  const result = await service.confirmSpend(preview.id, false, true);
  snapshot = service.snapshot();
  if (
    !acknowledgementPersisted || result.chain !== "btc" ||
    snapshot.intents.find((intent) => intent.txid === result.txid)?.phase !== "seen"
  ) throw new Error("Unsplit shared BTC acknowledgement was not durably recorded");
});

Deno.test("pending-split BTC spend retains the related split in its risk acknowledgement", async () => {
  const shared = coin("61".repeat(32), 100_000, FIXTURE_ADDRESSES[0], true, true);
  const { repository, service, blake, btc } = await unlockedFixture(baseState([shared]));
  blake.utxos.set(shared.address, [utxo(shared)]);
  btc.utxos.set(shared.address, [utxo(shared)]);
  const splitPreview = await service.previewSpend({
    chain: "blake",
    purpose: "split",
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const split = await service.confirmSpend(splitPreview.id);
  let snapshot = await service.sync();
  const splitIntent = snapshot.intents.find((intent) =>
    intent.kind === "blake-unified" && intent.txid === split.txid
  );
  if (!splitIntent) throw new Error("Pending split intent is missing");
  if (!snapshot.selectableBtcOutpoints.includes(shared.outpoint)) {
    throw new Error("Pending split did not expose BTC while BLAKE still reported the input");
  }
  const btcPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (
    btcPreview.risks.length !== 1 ||
    btcPreview.risks[0].kind !== "shared-coin-replay" ||
    btcPreview.risks[0].splitIntentIds[0] !== splitIntent.id
  ) throw new Error("Preview did not surface the exact pending split risk");
  await assertRejects(
    () => service.confirmSpend(btcPreview.id, false, false),
    "replay risk requires explicit confirmation",
  );
  let acknowledgementPersisted = false;
  btc.beforeBroadcast = async (rawTx) => {
    const state = await repository.loadState();
    const intent = state.intents.find((candidate) => candidate.rawTx === rawTx);
    acknowledgementPersisted = intent?.kind === "btc-spend" &&
      intent.phase === "broadcast-unknown" &&
      intent.replayRisk?.splitIntentIds.includes(splitIntent.id) === true;
  };
  const result = await service.confirmSpend(btcPreview.id, false, true);
  snapshot = service.snapshot();
  if (
    !acknowledgementPersisted || result.chain !== "btc" ||
    snapshot.intents.find((intent) => intent.txid === result.txid)?.phase !== "seen"
  ) throw new Error("Acknowledged emergency BTC spend was not durably recorded");
});

Deno.test("per-chain targets govern split protection and refresh cached intent phases", async () => {
  const shared = coin("61".repeat(32), 100_000, FIXTURE_ADDRESSES[0], true, true);
  const state = baseState([shared]);
  state.settings.blakeConfirmations = 6;
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(shared.address, [utxo(shared)]);
  btc.utxos.set(shared.address, [utxo(shared)]);
  await service.sync();

  const splitPreview = await service.previewSpend({
    chain: "blake",
    purpose: "split",
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const split = await service.confirmSpend(splitPreview.id);
  blake.utxos.set(shared.address, []);
  const btcRequest = {
    chain: "btc" as const,
    purpose: "send" as const,
    outpoints: [shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  };
  for (const confirmations of [0, 1, 5, 6]) {
    await service.updateSettings({ blakeConfirmations: confirmations === 0 ? 0 : 6 });
    blake.statuses.set(
      split.txid,
      confirmations === 0 ? { confirmed: false } : {
        confirmed: true,
        block_height: blake.tip - confirmations + 1,
      },
    );
    const snapshot = await service.sync();
    const expectedPhase = confirmations < 6 ? "seen" : "confirmed";
    if (snapshot.intents.find((intent) => intent.txid === split.txid)?.phase !== expectedPhase) {
      throw new Error(`Incorrect split phase at ${confirmations} BLAKE confirmations`);
    }
    const preview = await service.previewSpend(btcRequest);
    if (
      preview.risks.length !== (confirmations < 6 ? 1 : 0) ||
      preview.replayProtectionSplitIntentIds.length !== (confirmations < 6 ? 0 : 1)
    ) throw new Error("Replay warning did not follow the BLAKE confirmation target");
    await service.cancelSpendPreview(preview.id);
  }

  const protectedPreview = await service.previewSpend(btcRequest);
  let snapshot = await service.updateSettings({ blakeConfirmations: 7 });
  if (
    snapshot.intents.find((intent) => intent.txid === split.txid)?.phase !== "seen" ||
    snapshot.outputs.find((output) => output.outpoint === shared.outpoint)?.splitState !==
      "split-pending"
  ) throw new Error("Raising the target did not immediately withdraw cached split protection");
  await assertRejects(
    () => service.confirmSpend(protectedPreview.id),
    "Transaction risk changed",
  );
  if (btc.broadcasts.length !== 0) throw new Error("BTC broadcast without the new replay warning");

  const reopened = new WalletService(repository);
  snapshot = await reopened.initialize();
  if (
    snapshot.settings.blakeConfirmations !== 7 || snapshot.settings.btcConfirmations !== 1 ||
    snapshot.intents.find((intent) => intent.txid === split.txid)?.phase !== "seen"
  ) throw new Error("Confirmation settings and updated protection state did not persist");

  snapshot = await service.updateSettings({ btcConfirmations: 3, blakeConfirmations: 6 });
  if (snapshot.intents.find((intent) => intent.txid === split.txid)?.phase !== "confirmed") {
    throw new Error("Lowering the target did not re-evaluate cached confirmations");
  }
  const btcPreview = await service.previewSpend(btcRequest);
  if (btcPreview.risks.length !== 0) throw new Error("Confirmed protection was not restored");
  const spend = await service.confirmSpend(btcPreview.id);
  btc.utxos.set(shared.address, []);
  btc.statuses.set(spend.txid, { confirmed: true, block_height: btc.tip - 1 });
  snapshot = await service.sync();
  if (
    snapshot.intents.find((intent) => intent.txid === spend.txid)?.phase !== "seen" ||
    snapshot.intents.find((intent) => intent.txid === split.txid)?.phase !== "confirmed"
  ) throw new Error("BTC and BLAKE intent confirmation targets were not independent");
  snapshot = await service.updateSettings({ btcConfirmations: 2 });
  if (snapshot.intents.find((intent) => intent.txid === spend.txid)?.phase !== "confirmed") {
    throw new Error("BTC target change did not re-evaluate its cached confirmations");
  }
});

Deno.test("one confirmed split coin protects a mixed BTC transaction from replay", async () => {
  const anchor = coin("62".repeat(32), 100_000, FIXTURE_ADDRESSES[0], true, true);
  const shared = coin("63".repeat(32), 80_000, FIXTURE_ADDRESSES[0], true, true);
  const { repository, service, blake, btc } = await unlockedFixture(
    baseState([anchor, shared]),
  );
  blake.utxos.set(anchor.address, [utxo(anchor), utxo(shared)]);
  btc.utxos.set(anchor.address, [utxo(anchor), utxo(shared)]);
  await service.sync();

  const splitPreview = await service.previewSpend({
    chain: "blake",
    purpose: "split",
    outpoints: [anchor.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const split = await service.confirmSpend(splitPreview.id);
  blake.utxos.set(anchor.address, [utxo(shared)]);
  blake.statuses.set(split.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "64".repeat(32),
  });
  const splitSnapshot = await service.sync();
  const splitIntent = splitSnapshot.intents.find((intent) =>
    intent.kind === "blake-unified" && intent.txid === split.txid
  );
  if (!splitIntent) throw new Error("Confirmed split intent is missing");

  const btcPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [anchor.outpoint, shared.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (
    btcPreview.risks.length !== 0 ||
    btcPreview.replayProtectionSplitIntentIds[0] !== splitIntent.id
  ) throw new Error("Mixed BTC preview did not recognize its confirmed split input");

  let protectionPersisted = false;
  btc.beforeBroadcast = async (rawTx) => {
    const state = await repository.loadState();
    const intent = state.intents.find((candidate) => candidate.rawTx === rawTx);
    protectionPersisted = intent?.kind === "btc-spend" &&
      intent.phase === "broadcast-unknown" && !intent.replayRisk &&
      intent.replayProtection?.splitIntentIds[0] === splitIntent.id;
  };
  const btcSpend = await service.confirmSpend(btcPreview.id);
  if (!protectionPersisted) {
    throw new Error("BTC transaction did not retain its confirmed split protection");
  }

  btc.statuses.set(btcSpend.txid, null);
  let snapshot = await service.sync();
  const btcIntent = (await repository.loadState()).intents.find((intent) =>
    intent.kind === "btc-spend" && intent.txid === btcSpend.txid
  );
  if (
    !btcIntent ||
    snapshot.intents.find((intent) => intent.id === btcIntent.id)?.phase !== "recoverable"
  ) {
    throw new Error("Missing BTC transaction did not become recoverable before abandonment");
  }
  snapshot = await service.abandonIntent(btcIntent.id);
  if (snapshot.intents.find((intent) => intent.id === btcIntent.id)?.phase !== "abandoned") {
    throw new Error("BTC transaction was not abandoned locally");
  }

  blake.utxos.set(anchor.address, [utxo(anchor), utxo(shared)]);
  blake.statuses.set(split.txid, null);
  snapshot = await service.sync();
  const splitSummary = snapshot.intents.find((intent) => intent.id === splitIntent.id);
  if (splitSummary?.phase !== "recoverable" || splitSummary.canAbandon) {
    throw new Error("Reorged replay-protection split was not retained for recovery");
  }
  await assertRejects(
    () => service.abandonIntent(splitIntent.id),
    "protects a Bitcoin transaction",
  );
});

Deno.test("funding replay stays disabled until wallet recovery completes", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const { service, blake, btc } = await unlockedFixture(baseState([candidate]));
  blake.utxos.set(candidate.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.transactionHexes.set(funding.txid, funding.rawTx);

  const preview = await service.previewReplay(funding.txid);
  const recovering = await service.updateSettings({ scanGap: 11 });
  if (recovering.recoveryScanComplete || recovering.replayCandidateTxids.length !== 0) {
    throw new Error("Recovery exposed a partial replay candidate list");
  }
  await assertRejects(
    () => service.confirmReplay(preview.id),
    "Finish wallet recovery",
  );
  await assertRejects(
    () => service.previewReplay(funding.txid),
    "Finish wallet recovery",
  );
  if (blake.broadcasts.length !== 0) throw new Error("Replay broadcast during wallet recovery");
});

Deno.test("replay confirmation persists newly observed shared provenance before rejecting", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const { repository, service, blake, btc } = await unlockedFixture(baseState([candidate]));
  blake.utxos.set(candidate.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.transactionHexes.set(funding.txid, funding.rawTx);

  const preview = await service.previewReplay(funding.txid);
  blake.utxos.set(candidate.address, [utxo(candidate)]);
  await assertRejects(() => service.confirmReplay(preview.id), "not a fresh BTC-only");
  if (!(await repository.loadState()).sharedProvenance[candidate.outpoint]) {
    throw new Error("Rejected stale replay lost newly observed shared provenance");
  }
});

Deno.test("replay inspection verifies the BLAKE checkpoint before recording provenance", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const { repository, service, blake, btc } = await unlockedFixture(baseState([candidate]));
  blake.checkpointHash = CHECKPOINTS.btc;
  blake.statuses.set(funding.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "75".repeat(32),
  });
  btc.transactionHexes.set(funding.txid, funding.rawTx);

  await assertRejects(() => service.previewReplay(funding.txid), "failed the fork checkpoint");
  if (Object.keys((await repository.loadState()).sharedProvenance).length !== 0) {
    throw new Error("Unverified BLAKE backend created durable shared provenance");
  }
});

Deno.test("funding replay reserves every known wallet input it consumes", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const source = {
    ...coin("76".repeat(32), 120_000, FIXTURE_ADDRESSES[1], true, false),
    outpoint: `${"76".repeat(32)}:1`,
    vout: 1,
  };
  const state = baseState([candidate, source]);
  state.sharedProvenance[source.outpoint] = { firstObservedAt: new Date().toISOString() };
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(candidate.address, []);
  blake.utxos.set(source.address, [utxo(source)]);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.transactionHexes.set(funding.txid, funding.rawTx);
  if (!service.snapshot().selectableBlakeOutpoints.includes(source.outpoint)) {
    throw new Error("Replay source was not selectable before an intent existed");
  }

  blake.broadcastFailure = new Error("connection closed after replay POST");
  const preview = await service.previewReplay(funding.txid);
  await assertRejects(
    () => service.confirmReplay(preview.id),
    "connection closed after replay POST",
  );

  const persisted = await repository.loadState();
  const replay = persisted.intents.find((intent) =>
    intent.kind === "blake-replay" && intent.txid === funding.txid
  );
  if (
    replay?.kind !== "blake-replay" || replay.phase !== "broadcast-unknown" ||
    replay.walletInputOutpoints.length !== 1 ||
    replay.walletInputOutpoints[0] !== source.outpoint ||
    service.snapshot().selectableBlakeOutpoints.includes(source.outpoint)
  ) {
    throw new Error("Ambiguous replay did not reserve its known wallet input");
  }
  parseWalletState(JSON.parse(JSON.stringify(persisted)));
});

Deno.test("funding replay reconciles an existing spend of a restored input", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const source = {
    ...coin("76".repeat(32), 120_000, FIXTURE_ADDRESSES[1], false, false),
    outpoint: `${"76".repeat(32)}:1`,
    vout: 1,
  };
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let previousSpend: ReturnType<typeof signUnifiedSweep>;
  try {
    previousSpend = signUnifiedSweep(
      createSweepTemplate(
        [{
          txid: source.txid,
          vout: source.vout,
          value: source.value,
          scriptPubKey: source.scriptPubKey,
          path: source.path,
        }],
        FIXTURE_ADDRESSES[2].address,
        2,
        961_650,
      ),
      keychain,
    );
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
  const previousIntentId = "00000000-0000-4000-8000-000000000077";
  const state = baseState([candidate, source]);
  state.intents.push({
    id: previousIntentId,
    kind: "blake-unified",
    chain: "blake",
    txid: previousSpend.txid,
    rawTx: previousSpend.rawTx,
    createdAt: new Date().toISOString(),
    phase: "confirmed",
    broadcastStartedAt: new Date().toISOString(),
    inputOutpoints: [source.outpoint],
    sharedOutpoints: [],
    parentReplayIntentIds: [],
  });
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(candidate.address, []);
  blake.utxos.set(source.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.utxos.set(source.address, []);
  btc.transactionHexes.set(funding.txid, funding.rawTx);

  const preview = await service.previewReplay(funding.txid);
  blake.utxos.set(source.address, [utxo(source)]);
  blake.statuses.set(previousSpend.txid, null);
  await assertRejects(() => service.confirmReplay(preview.id), "incompatible active intents");

  const persisted = await repository.loadState();
  if (
    persisted.intents.find((intent) => intent.id === previousIntentId)?.phase !== "recoverable" ||
    persisted.intents.some((intent) =>
      intent.kind === "blake-replay" && intent.txid === funding.txid
    ) || blake.broadcasts.length !== 0
  ) {
    throw new Error("Replay did not fail closed after its restored input spend was reorged");
  }
});

Deno.test("funding replay does not reserve a historical input absent on BLAKE", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const source = {
    ...coin("76".repeat(32), 120_000, FIXTURE_ADDRESSES[1], false, false),
    outpoint: `${"76".repeat(32)}:1`,
    vout: 1,
  };
  const state = baseState([candidate, source]);
  state.intents.push({
    id: "00000000-0000-4000-8000-000000000096",
    kind: "btc-spend",
    chain: "btc",
    txid: funding.txid,
    rawTx: funding.rawTx,
    createdAt: new Date().toISOString(),
    phase: "confirmed",
    broadcastStartedAt: new Date().toISOString(),
    inputOutpoints: [source.outpoint],
  });
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(candidate.address, []);
  blake.utxos.set(source.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.utxos.set(source.address, []);
  btc.transactionHexes.set(funding.txid, funding.rawTx);
  blake.broadcastFailure = new Error("replay rejected because its source is absent");

  const preview = await service.previewReplay(funding.txid);
  await assertRejects(
    () => service.confirmReplay(preview.id),
    "replay rejected because its source is absent",
  );
  const replay = (await repository.loadState()).intents.find((intent) =>
    intent.kind === "blake-replay" && intent.txid === funding.txid
  );
  if (replay?.kind !== "blake-replay" || replay.walletInputOutpoints.length !== 0) {
    throw new Error("A historical input absent on BLAKE was incorrectly reserved");
  }

  const snapshot = await service.abandonIntent(replay.id);
  if (
    snapshot.intents.find((intent) => intent.id === replay.id)?.phase !== "abandoned" ||
    !snapshot.replayCandidateTxids.includes(funding.txid)
  ) {
    throw new Error("The rejected replay could not release its valid BTC output");
  }
});

Deno.test("funding replay tracks every wallet output recreated by the transaction", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const retained = {
    ...coin(
      funding.txid,
      funding.values[1],
      FIXTURE_ADDRESSES[0],
      false,
      true,
    ),
    outpoint: `${funding.txid}:1`,
    vout: 1,
  };
  const state = baseState([candidate, retained]);
  state.sharedProvenance[retained.outpoint] = { firstObservedAt: new Date().toISOString() };
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let retainedSplit: ReturnType<typeof signUnifiedSweep>;
  try {
    retainedSplit = signUnifiedSweep(
      createSweepTemplate(
        [{
          txid: retained.txid,
          vout: retained.vout,
          value: retained.value,
          scriptPubKey: retained.scriptPubKey,
          path: retained.path,
        }],
        FIXTURE_ADDRESSES[1].address,
        2,
        961_650,
      ),
      keychain,
    );
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
  const retainedSplitIntentId = "00000000-0000-4000-8000-000000000076";
  state.intents.push({
    id: retainedSplitIntentId,
    kind: "blake-unified",
    chain: "blake",
    txid: retainedSplit.txid,
    rawTx: retainedSplit.rawTx,
    createdAt: new Date().toISOString(),
    phase: "recoverable",
    broadcastStartedAt: new Date().toISOString(),
    inputOutpoints: [retained.outpoint],
    sharedOutpoints: [retained.outpoint],
    parentReplayIntentIds: [],
  });
  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(candidate.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate), utxo(retained)]);
  btc.transactionHexes.set(funding.txid, funding.rawTx);

  const preview = await service.previewReplay(funding.txid);
  if (
    preview.walletOutpoints.length !== 2 ||
    !preview.walletOutpoints.includes(candidate.outpoint) ||
    !preview.walletOutpoints.includes(retained.outpoint) ||
    preview.walletValue !== funding.values[0] + funding.values[1]
  ) throw new Error("Replay preview omitted a wallet output that the raw transaction recreates");

  await service.confirmReplay(preview.id);
  const persisted = await repository.loadState();
  const replayIntent = persisted.intents.find((intent) =>
    intent.kind === "blake-replay" && intent.txid === funding.txid
  );
  if (
    replayIntent?.kind !== "blake-replay" || replayIntent.walletOutpoints.length !== 2 ||
    !replayIntent.walletOutpoints.includes(candidate.outpoint) ||
    !replayIntent.walletOutpoints.includes(retained.outpoint) ||
    !persisted.sharedProvenance[candidate.outpoint] ||
    !persisted.sharedProvenance[retained.outpoint]
  ) throw new Error("Replay intent did not govern every recreated wallet output");
  const linkedSplit = persisted.intents.find((intent) => intent.id === retainedSplitIntentId);
  if (
    linkedSplit?.kind !== "blake-unified" ||
    !linkedSplit.parentReplayIntentIds.includes(replayIntent.id)
  ) throw new Error("Existing child split was not linked to the new replay parent");
});

Deno.test("an exposed abandoned replay is revived and relinked to its child split", async () => {
  const funding = multiOutputFunding();
  const replayed = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    true,
    true,
  );
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let child: ReturnType<typeof signUnifiedSweep>;
  try {
    child = signUnifiedSweep(
      createSweepTemplate(
        [{
          txid: replayed.txid,
          vout: replayed.vout,
          value: replayed.value,
          scriptPubKey: replayed.scriptPubKey,
          path: replayed.path,
        }],
        FIXTURE_ADDRESSES[1].address,
        2,
        961_650,
      ),
      keychain,
    );
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }

  const now = new Date().toISOString();
  const replayIntentId = "00000000-0000-4000-8000-000000000077";
  const childIntentId = "00000000-0000-4000-8000-000000000078";
  const state = baseState([replayed]);
  state.sharedProvenance[replayed.outpoint] = { firstObservedAt: now };
  state.intents.push({
    id: replayIntentId,
    kind: "blake-replay",
    chain: "blake",
    txid: funding.txid,
    rawTx: funding.rawTx,
    createdAt: now,
    phase: "abandoned",
    broadcastStartedAt: now,
    abandonedAt: now,
    walletInputOutpoints: [],
    walletOutpoints: [replayed.outpoint],
  }, {
    id: childIntentId,
    kind: "blake-unified",
    chain: "blake",
    txid: child.txid,
    rawTx: child.rawTx,
    createdAt: now,
    phase: "recoverable",
    broadcastStartedAt: now,
    inputOutpoints: [replayed.outpoint],
    sharedOutpoints: [replayed.outpoint],
    parentReplayIntentIds: [],
  });

  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(replayed.address, [utxo(replayed)]);
  btc.utxos.set(replayed.address, [utxo(replayed)]);
  blake.statuses.set(funding.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "79".repeat(32),
  });
  blake.statuses.set(child.txid, null);

  const snapshot = await service.sync();
  const revived = snapshot.intents.find((intent) => intent.id === replayIntentId);
  const persistedChild = (await repository.loadState()).intents.find((intent) =>
    intent.id === childIntentId
  );
  if (
    revived?.phase !== "confirmed" || persistedChild?.kind !== "blake-unified" ||
    !persistedChild.parentReplayIntentIds.includes(replayIntentId)
  ) {
    throw new Error("Resurfaced replay was not revived with its child dependency restored");
  }
  parseWalletState(JSON.parse(JSON.stringify(await repository.loadState())));
});

Deno.test("a replay retry replaces an abandoned equivalent parent dependency", async () => {
  const funding = multiOutputFunding();
  const candidate = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let child: ReturnType<typeof signUnifiedSweep>;
  try {
    child = signUnifiedSweep(
      createSweepTemplate(
        [{
          txid: candidate.txid,
          vout: candidate.vout,
          value: candidate.value,
          scriptPubKey: candidate.scriptPubKey,
          path: candidate.path,
        }],
        FIXTURE_ADDRESSES[1].address,
        2,
        961_650,
      ),
      keychain,
    );
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }

  const now = new Date().toISOString();
  const abandonedReplayId = "00000000-0000-4000-8000-000000000079";
  const childIntentId = "00000000-0000-4000-8000-000000000080";
  const state = baseState([candidate]);
  state.intents.push({
    id: abandonedReplayId,
    kind: "blake-replay",
    chain: "blake",
    txid: funding.txid,
    rawTx: funding.rawTx,
    createdAt: now,
    phase: "abandoned",
    broadcastStartedAt: now,
    abandonedAt: now,
    walletInputOutpoints: [],
    walletOutpoints: [candidate.outpoint],
  }, {
    id: childIntentId,
    kind: "blake-unified",
    chain: "blake",
    txid: child.txid,
    rawTx: child.rawTx,
    createdAt: now,
    phase: "abandoned",
    broadcastStartedAt: now,
    abandonedAt: now,
    inputOutpoints: [candidate.outpoint],
    sharedOutpoints: [],
    parentReplayIntentIds: [abandonedReplayId],
  });

  const { repository, service, blake, btc } = await unlockedFixture(state);
  blake.utxos.set(candidate.address, []);
  btc.utxos.set(candidate.address, [utxo(candidate)]);
  btc.transactionHexes.set(funding.txid, funding.rawTx);
  const preview = await service.previewReplay(funding.txid);
  await service.confirmReplay(preview.id);

  const persisted = await repository.loadState();
  const retry = persisted.intents.find((intent) =>
    intent.kind === "blake-replay" && intent.id !== abandonedReplayId &&
    intent.txid === funding.txid
  );
  const relinkedChild = persisted.intents.find((intent) => intent.id === childIntentId);
  if (
    !retry || relinkedChild?.kind !== "blake-unified" ||
    relinkedChild.parentReplayIntentIds.length !== 1 ||
    relinkedChild.parentReplayIntentIds[0] !== retry.id
  ) {
    throw new Error("Replay retry retained an abandoned equivalent parent dependency");
  }
  parseWalletState(JSON.parse(JSON.stringify(persisted)));
});

Deno.test("replay recovery attempts every protective child before reporting failures", async () => {
  const funding = multiOutputFunding();
  const first = coin(
    funding.txid,
    funding.values[0],
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const second = {
    ...coin(
      funding.txid,
      funding.values[1],
      FIXTURE_ADDRESSES[0],
      false,
      true,
    ),
    outpoint: `${funding.txid}:1`,
    vout: 1,
  };
  const outputs = [first, second];
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let signed: Array<{
    split: ReturnType<typeof signUnifiedSweep>;
    btc: ReturnType<typeof signBtcSweep>;
  }> = [];
  try {
    signed = outputs.map((output) => {
      const spendable = [{
        txid: output.txid,
        vout: output.vout,
        value: output.value,
        scriptPubKey: output.scriptPubKey,
        path: output.path,
      }];
      return {
        split: signUnifiedSweep(
          createSweepTemplate(spendable, FIXTURE_ADDRESSES[1].address, 2, 961_650),
          keychain,
        ),
        btc: signBtcSweep(
          createSweepTemplate(
            spendable,
            FIXTURE_ADDRESSES[1].address,
            2,
            961_650,
            "btc-standard",
          ),
          keychain,
        ),
      };
    });
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }

  const now = new Date().toISOString();
  const parentId = "00000000-0000-4000-8000-000000000091";
  const childIds = [
    "00000000-0000-4000-8000-000000000092",
    "00000000-0000-4000-8000-000000000093",
  ];
  const btcIds = [
    "00000000-0000-4000-8000-000000000094",
    "00000000-0000-4000-8000-000000000095",
  ];
  const state = baseState(outputs);
  for (const output of outputs) {
    state.sharedProvenance[output.outpoint] = { firstObservedAt: now };
  }
  state.intents = [
    {
      id: parentId,
      kind: "blake-replay",
      chain: "blake",
      txid: funding.txid,
      rawTx: funding.rawTx,
      createdAt: now,
      phase: "recoverable",
      broadcastStartedAt: now,
      walletInputOutpoints: [],
      walletOutpoints: outputs.map((output) => output.outpoint),
    },
    ...outputs.map((output, index) => ({
      id: childIds[index],
      kind: "blake-unified" as const,
      chain: "blake" as const,
      txid: signed[index].split.txid,
      rawTx: signed[index].split.rawTx,
      createdAt: now,
      phase: "recoverable" as const,
      broadcastStartedAt: now,
      inputOutpoints: [output.outpoint],
      sharedOutpoints: [output.outpoint],
      parentReplayIntentIds: [parentId],
    })),
    ...outputs.map((output, index) => ({
      id: btcIds[index],
      kind: "btc-spend" as const,
      chain: "btc" as const,
      txid: signed[index].btc.txid,
      rawTx: signed[index].btc.rawTx,
      createdAt: now,
      phase: "confirmed" as const,
      broadcastStartedAt: now,
      inputOutpoints: [output.outpoint],
      replayProtection: { splitIntentIds: [childIds[index]] },
    })),
  ];

  const { repository, service, blake } = await unlockedFixture(state);
  blake.broadcastFailures.set(signed[0].split.txid, new Error("first child rejected"));
  await assertRejects(
    () => service.rebroadcastIntent(parentId),
    "1 protective split",
  );

  const persisted = await repository.loadState();
  const firstChild = persisted.intents.find((intent) => intent.id === childIds[0]);
  const secondChild = persisted.intents.find((intent) => intent.id === childIds[1]);
  if (
    firstChild?.phase !== "broadcast-unknown" || secondChild?.phase !== "seen" ||
    !blake.broadcasts.includes(funding.rawTx) ||
    !blake.broadcasts.includes(signed[1].split.rawTx)
  ) {
    throw new Error("A failed protective child prevented a later child from broadcasting");
  }
});

Deno.test("replayed funding stays governed and child split tracks its parent dependency", async () => {
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let funding: ReturnType<typeof signBtcSweep>;
  try {
    funding = signBtcSweep(
      createSweepTemplate(
        [{
          txid: "71".repeat(32),
          vout: 1,
          value: 120_000,
          scriptPubKey: FIXTURE_ADDRESSES[1].scriptPubKey,
          path: FIXTURE_ADDRESSES[1].path,
        }],
        FIXTURE_ADDRESSES[0].address,
        2,
        900_000,
        "btc-standard",
      ),
      keychain,
    );
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
  const fundingCoin = coin(
    funding.txid,
    funding.outputValue,
    FIXTURE_ADDRESSES[0],
    false,
    true,
  );
  const localBtcIntentId = "00000000-0000-4000-8000-000000000071";
  const state = baseState([fundingCoin]);
  state.intents.push({
    id: localBtcIntentId,
    kind: "btc-spend",
    chain: "btc",
    txid: funding.txid,
    rawTx: funding.rawTx,
    createdAt: new Date().toISOString(),
    phase: "confirmed",
    broadcastStartedAt: new Date().toISOString(),
    inputOutpoints: [`${"71".repeat(32)}:1`],
  });
  const { repository, service, blake, btc } = await unlockedFixture(state);
  btc.utxos.set(fundingCoin.address, [utxo(fundingCoin)]);
  blake.utxos.set(fundingCoin.address, []);
  btc.transactionHexes.set(funding.txid, funding.rawTx);
  btc.statuses.set(funding.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "70".repeat(32),
  });

  blake.broadcastFailure = new Error("connection closed after replay POST");
  const uncertainPreview = await service.previewReplay(funding.txid);
  await assertRejects(
    () => service.confirmReplay(uncertainPreview.id),
    "connection closed after replay POST",
  );
  const uncertainReplay = service.snapshot().intents.find((intent) =>
    intent.kind === "blake-replay" && intent.phase === "broadcast-unknown"
  );
  if (!uncertainReplay) throw new Error("Uncertain replay intent is missing");
  let snapshot = await service.sync();
  const replaySummary = snapshot.intents.find((intent) => intent.id === uncertainReplay.id);
  if (
    replaySummary?.phase !== "recoverable" || !replaySummary.canAbandon ||
    (await repository.loadState()).sharedProvenance[fundingCoin.outpoint]
  ) throw new Error("Unobserved replay attempt could not be safely abandoned");
  snapshot = await service.abandonIntent(uncertainReplay.id);
  if (!snapshot.replayCandidateTxids.includes(funding.txid)) {
    throw new Error("Abandoned unobserved replay did not restore its candidate");
  }

  blake.broadcastFailure = null;
  const preview = await service.previewReplay(funding.txid);
  if (
    preview.inputCount !== 1 || preview.outputCount !== 1 ||
    preview.walletOutpoints[0] !== fundingCoin.outpoint
  ) throw new Error("Replay preview did not describe the complete funding transaction");
  let durableBeforePost = false;
  blake.beforeBroadcast = async (rawTx) => {
    const state = await repository.loadState();
    const intent = state.intents.find((candidate) =>
      candidate.kind === "blake-replay" && candidate.rawTx === rawTx &&
      candidate.phase === "broadcast-unknown"
    );
    durableBeforePost = intent?.kind === "blake-replay" &&
      intent.phase === "broadcast-unknown" &&
      !state.sharedProvenance[fundingCoin.outpoint];
  };
  const replay = await service.confirmReplay(preview.id);
  if (!durableBeforePost || replay.rawTx !== funding.rawTx || replay.action !== "replay") {
    throw new Error("Replay was not persisted before broadcasting the original transaction");
  }
  if (!(await repository.loadState()).sharedProvenance[fundingCoin.outpoint]) {
    throw new Error("Accepted replay did not record shared provenance");
  }
  const replayIntent = (await repository.loadState()).intents.find((intent) =>
    intent.kind === "blake-replay" && intent.phase === "seen" && intent.txid === funding.txid
  );
  if (!replayIntent || replayIntent.id === uncertainReplay.id) {
    throw new Error("Replay retry did not receive an independent intent identity");
  }
  const sameTxidIntents = (await repository.loadState()).intents.filter((intent) =>
    intent.txid === funding.txid
  );
  if (
    !sameTxidIntents.some((intent) => intent.id === localBtcIntentId) ||
    !sameTxidIntents.some((intent) => intent.id === replayIntent.id)
  ) throw new Error("Bitcoin and BTC-BLAKE intents with one txid did not coexist");
  snapshot = await service.updateSettings({ btcConfirmations: 0, blakeConfirmations: 0 });
  if (
    snapshot.selectableBlakeOutpoints.includes(fundingCoin.outpoint) ||
    snapshot.splittableOutpoints.includes(fundingCoin.outpoint)
  ) throw new Error("Unconfirmed replay exposed its output to a child split");

  blake.utxos.set(fundingCoin.address, [utxo(fundingCoin)]);
  blake.statuses.set(funding.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "72".repeat(32),
  });
  snapshot = await service.sync();
  if (
    snapshot.intents.find((intent) => intent.id === replayIntent.id)?.phase !== "confirmed" ||
    !snapshot.splittableOutpoints.includes(fundingCoin.outpoint)
  ) throw new Error("Confirmed replay did not release its output for splitting");

  const childPreview = await service.previewSpend({
    chain: "blake",
    purpose: "split",
    outpoints: [fundingCoin.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  const child = await service.confirmSpend(childPreview.id);
  const childIntent = (await repository.loadState()).intents.find((intent) =>
    intent.txid === child.txid
  );
  if (
    childIntent?.kind !== "blake-unified" ||
    childIntent.parentReplayIntentIds[0] !== replayIntent.id
  ) throw new Error("Child split did not retain its replay-parent dependency");
  const childIntentId = childIntent.id;

  blake.utxos.set(fundingCoin.address, []);
  blake.statuses.set(child.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "74".repeat(32),
  });
  snapshot = await service.sync();
  if (
    snapshot.intents.find((intent) => intent.id === childIntentId)?.phase !== "confirmed" ||
    !snapshot.selectableBtcOutpoints.includes(fundingCoin.outpoint)
  ) throw new Error("Confirmed child split did not release its protected BTC copy");

  const btcPreview = await service.previewSpend({
    chain: "btc",
    purpose: "send",
    outpoints: [fundingCoin.outpoint],
    destination: FIXTURE_ADDRESSES[1].address,
    feeRate: 2,
  });
  if (
    btcPreview.risks.length !== 0 ||
    btcPreview.replayProtectionSplitIntentIds[0] !== childIntentId
  ) throw new Error("Confirmed child split was not used as BTC replay protection");
  const btcSpend = await service.confirmSpend(btcPreview.id);
  const protectedBtcIntent = (await repository.loadState()).intents.find((intent) =>
    intent.kind === "btc-spend" && intent.txid === btcSpend.txid
  );
  if (
    protectedBtcIntent?.kind !== "btc-spend" ||
    protectedBtcIntent.replayProtection?.splitIntentIds[0] !== childIntentId
  ) throw new Error("BTC intent did not retain its child-split protection");

  blake.statuses.set(funding.txid, null);
  blake.statuses.set(child.txid, null);
  btc.utxos.set(fundingCoin.address, [utxo(fundingCoin)]);
  btc.statuses.set(btcSpend.txid, null);
  snapshot = await service.sync();
  const parentSummary = snapshot.intents.find((intent) => intent.id === replayIntent.id);
  const childSummary = snapshot.intents.find((intent) => intent.id === childIntentId);
  const btcSummary = snapshot.intents.find((intent) => intent.id === protectedBtcIntent.id);
  if (
    parentSummary?.phase !== "recoverable" ||
    parentSummary.canAbandon ||
    !childSummary?.blockedBy.includes(replayIntent.id) ||
    btcSummary?.phase !== "recoverable" || btcSummary.canRebroadcast ||
    !btcSummary.blockedBy.includes(childIntentId) ||
    snapshot.selectableBtcOutpoints.includes(fundingCoin.outpoint)
  ) throw new Error("Parent reorg did not retain the linked replay, split, and BTC recovery state");
  await assertRejects(
    () => service.abandonIntent(replayIntent.id),
    "cannot be abandoned safely",
  );
  await assertRejects(
    () => service.rebroadcastIntent(childIntentId),
    "Rebroadcast parent replay",
  );
  await assertRejects(
    () => service.rebroadcastIntent(protectedBtcIntent.id),
    "Restore confirmed BLAKE split protection",
  );

  await service.rebroadcastIntent(replayIntent.id);
  snapshot = service.snapshot();
  const rebroadcastChild = snapshot.intents.find((intent) => intent.id === childIntentId);
  if (
    rebroadcastChild?.phase !== "seen" ||
    blake.broadcasts.at(-1) !== childIntent.rawTx
  ) {
    throw new Error("Accepted parent did not immediately rebroadcast its protective child");
  }
  await assertRejects(
    () => service.rebroadcastIntent(protectedBtcIntent.id),
    "Restore confirmed BLAKE split protection",
  );

  blake.statuses.set(funding.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "73".repeat(32),
  });
  blake.statuses.set(child.txid, {
    confirmed: true,
    block_height: 961_649,
    block_hash: "75".repeat(32),
  });
  snapshot = await service.sync();
  const recoveredBtc = snapshot.intents.find((intent) => intent.id === protectedBtcIntent.id);
  if (!recoveredBtc?.canRebroadcast || recoveredBtc.blockedBy.length !== 0) {
    throw new Error("Reconfirmed split protection did not release the BTC intent");
  }
  await service.rebroadcastIntent(protectedBtcIntent.id);
});

Deno.test("recovery scan resumes beyond address index 999", async () => {
  const state = baseState();
  state.recoveryScanComplete = false;
  state.recoveryScan = { nextIndex: 999, trailingGap: 0 };
  const { service, blake, btc } = await unlockedFixture(state);
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  let usedAddress: string;
  try {
    usedAddress = keychain.derive(0, 1_000).address;
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
  blake.usedAddresses.add(usedAddress);
  btc.usedAddresses.add(usedAddress);
  const snapshot = await service.sync();
  if (
    (!snapshot.recoveryScanComplete && (snapshot.recoveryScan?.nextIndex ?? 0) <= 1_000) ||
    !snapshot.addresses.some((address) => address.index === 1_000 && address.used)
  ) throw new Error("Recovery did not continue beyond address index 999");
});

Deno.test("recovery completion rechecks outputs discovered on earlier pages", async () => {
  const state = baseState();
  state.recoveryScanComplete = false;
  state.recoveryScan = { nextIndex: 0, trailingGap: 0 };
  const { service, btc } = await unlockedFixture(state);
  const entropy = entropyFromMnemonic(RECOVERY);
  const keychain = new Bip86Keychain(entropy);
  const addresses = new Map<number, WalletAddress>();
  try {
    for (const index of [0, 9, 18, 27]) addresses.set(index, keychain.derive(0, index));
  } finally {
    keychain.destroy();
    entropy.fill(0);
  }
  const firstAddress = addresses.get(0)!;
  const earlierPageCoin = coin("7a".repeat(32), 50_000, firstAddress, false, true);
  btc.utxos.set(firstAddress.address, [utxo(earlierPageCoin)]);
  for (const index of [9, 18, 27]) btc.usedAddresses.add(addresses.get(index)!.address);

  let snapshot = await service.sync();
  if (
    snapshot.recoveryScanComplete || snapshot.recoveryScan?.nextIndex !== 25 ||
    !snapshot.outputs.some((output) => output.outpoint === earlierPageCoin.outpoint)
  ) {
    throw new Error("First recovery page did not retain its discovered output and progress");
  }

  btc.utxos.set(firstAddress.address, []);
  snapshot = await service.sync();
  if (
    !snapshot.recoveryScanComplete ||
    snapshot.outputs.some((output) => output.outpoint === earlierPageCoin.outpoint)
  ) {
    throw new Error("Recovery completed with a stale output from an earlier page");
  }
});
