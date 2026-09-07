import type { SecretRecord } from "./keys.ts";
import { normalizeEsploraUrl } from "./esplora.ts";
import { assertWalletStateInvariants } from "./intent_state.ts";
import {
  type ChainCoinObservation,
  type ChainTxStatus,
  DEFAULT_SETTINGS,
  emptyPublicState,
  type IntentObservation,
  type PersistedCoin,
  type TransactionIntent,
  type WalletAddress,
  type WalletPublicState,
} from "./types.ts";

export interface WalletRepository {
  loadState(): Promise<WalletPublicState>;
  saveState(state: WalletPublicState): Promise<void>;
  loadSecret(): Promise<SecretRecord | null>;
  saveSecret(secret: SecretRecord): Promise<void>;
  exists(): Promise<boolean>;
}

export interface WalletDirectoryLock {
  close(): void;
  release(): Promise<void>;
}

const INTENT_PHASES = new Set([
  "prepared",
  "broadcast-unknown",
  "seen",
  "confirmed",
  "recoverable",
  "abandoned",
]);
const TXID = /^[0-9a-f]{64}$/u;
const OUTPOINT = /^[0-9a-f]{64}:(?:0|[1-9]\d*)$/u;
const INTENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_DERIVATION_INDEX = 0x7fff_ffff;
const MAX_FEE_RATE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validChainTxStatus(value: unknown): value is ChainTxStatus {
  if (!isRecord(value)) return false;
  if (
    typeof value.present !== "boolean" || typeof value.confirmed !== "boolean" ||
    (value.confirmed && !value.present)
  ) return false;
  if ((!value.present || !value.confirmed) && value.confirmations !== 0) return false;
  if (
    !value.present &&
    (value.blockHeight !== undefined || value.blockHash !== undefined)
  ) return false;
  return Number.isSafeInteger(value.confirmations) && (value.confirmations as number) >= 0 &&
    (value.blockHeight === undefined ||
      (Number.isSafeInteger(value.blockHeight) && (value.blockHeight as number) >= 0)) &&
    (value.blockHash === undefined || typeof value.blockHash === "string");
}

function validObservation(value: unknown): value is ChainCoinObservation {
  if (!isRecord(value)) return false;
  if (!validTimestamp(value.checkedAt) || typeof value.backendOk !== "boolean") return false;
  return value.backendOk
    ? validChainTxStatus(value.tx) && typeof value.unspent === "boolean" &&
      (!value.unspent || value.tx.present) &&
      value.error === undefined
    : value.tx === null && value.unspent === null && typeof value.error === "string";
}

function validIntentObservation(value: unknown): value is IntentObservation {
  if (!isRecord(value)) return false;
  if (!validTimestamp(value.checkedAt) || typeof value.backendOk !== "boolean") return false;
  return value.backendOk
    ? validChainTxStatus(value.tx) && value.error === undefined
    : value.tx === null && typeof value.error === "string";
}

function validAddress(value: unknown): value is WalletAddress {
  if (!isRecord(value)) return false;
  return typeof value.address === "string" && typeof value.scriptPubKey === "string" &&
    typeof value.path === "string" && (value.branch === 0 || value.branch === 1) &&
    Number.isSafeInteger(value.index) && (value.index as number) >= 0 &&
    (value.index as number) <= MAX_DERIVATION_INDEX &&
    typeof value.used === "boolean";
}

function validSettings(value: unknown): value is WalletPublicState["settings"] {
  if (!isRecord(value)) return false;
  const validBackendUrl = (url: unknown) => {
    if (typeof url !== "string" || url.length === 0) return false;
    try {
      normalizeEsploraUrl(url);
      return true;
    } catch {
      return false;
    }
  };
  const feeRateIsValid = (feeRate: unknown) =>
    feeRate === undefined ||
    (typeof feeRate === "number" && Number.isFinite(feeRate) && feeRate > 0 &&
      feeRate <= MAX_FEE_RATE);
  return validBackendUrl(value.btcApiUrl) && validBackendUrl(value.blakeApiUrl) &&
    (value.amountUnit === "btc" || value.amountUnit === "sat" || value.amountUnit === "bip177") &&
    [value.btcConfirmations, value.blakeConfirmations].every((confirmations) =>
      Number.isSafeInteger(confirmations) &&
      (confirmations as number) >= 0 && (confirmations as number) <= 1_000
    ) &&
    Number.isSafeInteger(value.scanGap) && (value.scanGap as number) >= 1 &&
    (value.scanGap as number) <= 1_000 &&
    feeRateIsValid(value.btcFeeRate) && feeRateIsValid(value.blakeFeeRate);
}

function validRecoveryScan(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.nextIndex) && (value.nextIndex as number) >= 0 &&
    (value.nextIndex as number) <= MAX_DERIVATION_INDEX + 1 &&
    Number.isSafeInteger(value.trailingGap) && (value.trailingGap as number) >= 0 &&
    (value.trailingGap as number) <= 1_000 &&
    (value.trailingGap as number) <= (value.nextIndex as number);
}

function validTip(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.height) && (value.height as number) >= 0 &&
    typeof value.fetchedAt === "string" && Number.isFinite(Date.parse(value.fetchedAt));
}

function validTips(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.btc === undefined || validTip(value.btc)) &&
    (value.blake === undefined || validTip(value.blake));
}

function validCoin(value: unknown): value is PersistedCoin {
  if (!isRecord(value)) return false;
  return typeof value.outpoint === "string" && OUTPOINT.test(value.outpoint) &&
    typeof value.txid === "string" && TXID.test(value.txid) &&
    Number.isSafeInteger(value.vout) && (value.vout as number) >= 0 &&
    (value.vout as number) <= 0xffff_ffff &&
    value.outpoint === `${value.txid}:${value.vout}` &&
    Number.isSafeInteger(value.value) && (value.value as number) > 0 &&
    typeof value.address === "string" && value.address.length > 0 &&
    typeof value.scriptPubKey === "string" && /^5120[0-9a-f]{64}$/u.test(value.scriptPubKey) &&
    typeof value.path === "string" && /^m\/86'\/0'\/0'\/[01]\/(?:0|[1-9]\d*)$/u.test(value.path) &&
    validObservation(value.blake) &&
    validObservation(value.btc);
}

function validIntent(value: unknown): value is TransactionIntent {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" || !INTENT_ID.test(value.id) ||
    typeof value.txid !== "string" || !TXID.test(value.txid) ||
    typeof value.rawTx !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(value.rawTx) ||
    !validTimestamp(value.createdAt) || typeof value.phase !== "string" ||
    !INTENT_PHASES.has(value.phase) ||
    (value.broadcastStartedAt !== undefined && !validTimestamp(value.broadcastStartedAt)) ||
    (value.lastBroadcastAt !== undefined && !validTimestamp(value.lastBroadcastAt)) ||
    (value.lastObservation !== undefined && !validIntentObservation(value.lastObservation)) ||
    (value.lastError !== undefined && typeof value.lastError !== "string") ||
    (value.abandonedAt !== undefined && !validTimestamp(value.abandonedAt))
  ) return false;
  const validOutpoints = (outpoints: unknown, allowEmpty = false) =>
    Array.isArray(outpoints) && (allowEmpty || outpoints.length > 0) &&
    outpoints.every((outpoint) => typeof outpoint === "string" && OUTPOINT.test(outpoint));
  if (value.kind === "blake-replay") {
    return value.chain === "blake" && validOutpoints(value.walletInputOutpoints, true) &&
      validOutpoints(value.walletOutpoints);
  }
  if (!validOutpoints(value.inputOutpoints)) return false;
  if (value.kind === "blake-unified") {
    return value.chain === "blake" && Array.isArray(value.sharedOutpoints) &&
      value.sharedOutpoints.every((outpoint) =>
        typeof outpoint === "string" && OUTPOINT.test(outpoint)
      ) &&
      Array.isArray(value.parentReplayIntentIds) &&
      value.parentReplayIntentIds.every((id) => typeof id === "string" && INTENT_ID.test(id));
  }
  if (value.kind !== "btc-spend" || value.chain !== "btc") return false;
  const validIntentIds = (candidate: unknown) =>
    Array.isArray(candidate) &&
    candidate.every((id) => typeof id === "string" && INTENT_ID.test(id));
  if (
    value.replayProtection !== undefined &&
    (!isRecord(value.replayProtection) ||
      !validIntentIds(value.replayProtection.splitIntentIds))
  ) return false;
  if (value.replayRisk === undefined) return true;
  return isRecord(value.replayRisk) && Array.isArray(value.replayRisk.kinds) &&
    value.replayRisk.kinds.length > 0 &&
    value.replayRisk.kinds.every((kind) =>
      kind === "shared-coin-replay" || kind === "possible-funding-replay"
    ) && validIntentIds(value.replayRisk.splitIntentIds) &&
    validTimestamp(value.replayRisk.acknowledgedAt);
}

export async function acquireWalletDirectoryLock(directory: string): Promise<WalletDirectoryLock> {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const normalizedDirectory = directory.replace(/[\\\/]$/u, "");
  await Deno.mkdir(normalizedDirectory, { recursive: true, mode: 0o700 });
  const file = await Deno.open(`${normalizedDirectory}${separator}.wallet.lock`, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    if (!await file.tryLock(true)) {
      throw new Error("BcashJr Wallet is already using this data directory");
    }
  } catch (error) {
    file.close();
    throw error;
  }

  let open = true;
  return {
    close() {
      if (!open) return;
      open = false;
      file.close();
    },
    async release() {
      if (!open) return;
      open = false;
      try {
        await file.unlock();
      } finally {
        file.close();
      }
    },
  };
}

export function parseWalletState(value: unknown): WalletPublicState {
  if (value === null || value === undefined) return emptyPublicState();
  if (!value || typeof value !== "object") throw new Error("Wallet state is malformed");
  const stored = value as Partial<WalletPublicState>;
  if (stored.schema !== 1) throw new Error("Wallet state is malformed");
  if (
    !Array.isArray(stored.addresses) || !Array.isArray(stored.coins) ||
    !Array.isArray(stored.intents) || !isRecord(stored.sharedProvenance) ||
    !isRecord(stored.settings) ||
    !validTips(stored.tips)
  ) {
    throw new Error("Wallet state is malformed");
  }
  if (typeof stored.recoveryPhraseAcknowledged !== "boolean") {
    throw new Error("Wallet state is malformed");
  }
  if (
    stored.settings.amountUnit !== "btc" && stored.settings.amountUnit !== "sat" &&
    stored.settings.amountUnit !== "bip177"
  ) {
    throw new Error("Wallet state is malformed");
  }
  const settings = {
    ...stored.settings,
    btcConfirmations: stored.settings.btcConfirmations === undefined
      ? DEFAULT_SETTINGS.btcConfirmations
      : stored.settings.btcConfirmations,
    blakeConfirmations: stored.settings.blakeConfirmations === undefined
      ? DEFAULT_SETTINGS.blakeConfirmations
      : stored.settings.blakeConfirmations,
  };
  if (!validSettings(settings)) {
    throw new Error("Wallet state contains invalid settings");
  }
  if (
    typeof stored.recoveryScanComplete !== "boolean" ||
    !Number.isSafeInteger(stored.nextReceiveIndex) ||
    (stored.nextReceiveIndex as number) < 0 ||
    (stored.nextReceiveIndex as number) > MAX_DERIVATION_INDEX ||
    !validRecoveryScan(stored.recoveryScan) ||
    (stored.recoveryScanComplete && stored.recoveryScan !== undefined) ||
    (stored.createdAt !== undefined && !validTimestamp(stored.createdAt)) ||
    (stored.lastSyncAt !== undefined && !validTimestamp(stored.lastSyncAt)) ||
    (stored.lastSyncError !== undefined && typeof stored.lastSyncError !== "string")
  ) {
    throw new Error("Wallet state contains invalid scan or safety fields");
  }
  if (!stored.intents.every(validIntent)) {
    throw new Error("Wallet state contains a malformed transaction intent");
  }
  if (
    Object.entries(stored.sharedProvenance).some(([outpoint, provenance]) =>
      !OUTPOINT.test(outpoint) || !isRecord(provenance) ||
      !validTimestamp(provenance.firstObservedAt)
    )
  ) {
    throw new Error("Wallet state contains invalid shared-output provenance");
  }
  const addresses = stored.addresses.filter(validAddress);
  const coins = stored.coins.filter(validCoin);
  const discarded = stored.addresses.length - addresses.length + stored.coins.length -
    coins.length;
  const parsed: WalletPublicState = {
    schema: 1,
    ...(stored.createdAt !== undefined ? { createdAt: stored.createdAt } : {}),
    recoveryPhraseAcknowledged: stored.recoveryPhraseAcknowledged,
    recoveryScanComplete: stored.recoveryScanComplete,
    ...(stored.recoveryScan !== undefined
      ? { recoveryScan: structuredClone(stored.recoveryScan) }
      : {}),
    nextReceiveIndex: stored.nextReceiveIndex as number,
    addresses: structuredClone(addresses),
    coins: structuredClone(coins),
    sharedProvenance: structuredClone(
      stored.sharedProvenance as WalletPublicState["sharedProvenance"],
    ),
    intents: structuredClone(stored.intents),
    tips: structuredClone(stored.tips as WalletPublicState["tips"]),
    settings: {
      btcApiUrl: settings.btcApiUrl,
      blakeApiUrl: settings.blakeApiUrl,
      amountUnit: settings.amountUnit,
      btcConfirmations: settings.btcConfirmations,
      blakeConfirmations: settings.blakeConfirmations,
      scanGap: settings.scanGap,
      ...(settings.btcFeeRate !== undefined ? { btcFeeRate: settings.btcFeeRate } : {}),
      ...(settings.blakeFeeRate !== undefined ? { blakeFeeRate: settings.blakeFeeRate } : {}),
    },
    ...(stored.lastSyncAt !== undefined ? { lastSyncAt: stored.lastSyncAt } : {}),
    ...(stored.lastSyncError !== undefined ? { lastSyncError: stored.lastSyncError } : {}),
  };
  if (discarded > 0) {
    parsed.recoveryScanComplete = false;
    parsed.recoveryScan = { nextIndex: 0, trailingGap: 0 };
    parsed.lastSyncAt = undefined;
    const detail = `Discarded ${discarded} malformed public cache entr${
      discarded === 1 ? "y" : "ies"
    }`;
    parsed.lastSyncError = parsed.lastSyncError ? `${parsed.lastSyncError}; ${detail}` : detail;
  }
  assertWalletStateInvariants(parsed);
  return parsed;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryWalletRepository implements WalletRepository {
  #state: WalletPublicState;
  #secret: SecretRecord | null = null;

  constructor(initialState = emptyPublicState()) {
    this.#state = clone(initialState);
  }

  loadState(): Promise<WalletPublicState> {
    return Promise.resolve(clone(this.#state));
  }

  saveState(state: WalletPublicState): Promise<void> {
    this.#state = clone(state);
    return Promise.resolve();
  }

  loadSecret(): Promise<SecretRecord | null> {
    return Promise.resolve(clone(this.#secret));
  }

  saveSecret(secret: SecretRecord): Promise<void> {
    this.#secret = clone(secret);
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(this.#secret !== null);
  }
}

export function defaultWalletDataDirectory(): string {
  const override = Deno.env.get("BCASHJR_DATA_DIR");
  if (override) return override;
  return walletDataDirectoryFor(Deno.build.os, (name) => Deno.env.get(name));
}

export function walletDataDirectoryFor(
  os: typeof Deno.build.os,
  env: (name: string) => string | undefined,
): string {
  if (os === "windows") {
    const base = env("APPDATA") ?? env("LOCALAPPDATA") ?? env("USERPROFILE");
    if (!base) throw new Error("Cannot determine the wallet data directory");
    return `${base.replace(/[\\/]$/u, "")}\\bcashjr-wallet`;
  }
  const xdg = env("XDG_DATA_HOME");
  if (xdg) return `${xdg.replace(/\/$/u, "")}/bcashjr-wallet`;
  const home = env("HOME");
  if (!home) throw new Error("Cannot determine the wallet data directory");
  const base = os === "darwin"
    ? `${home.replace(/\/$/u, "")}/Library/Application Support`
    : `${home.replace(/\/$/u, "")}/.local/share`;
  return `${base}/bcashjr-wallet`;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const directory = path.slice(0, path.lastIndexOf(separator));
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const data = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const file = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      let written = 0;
      while (written < data.length) written += await file.write(data.subarray(written));
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(temporary, path);
    if (Deno.build.os === "windows") {
      // Deno cannot open a Windows directory for fsync. Flush the renamed destination handle so
      // NTFS commits the replacement before an irreversible broadcast is allowed to proceed.
      const committedFile = await Deno.open(path, { read: true, write: true });
      try {
        await committedFile.sync();
      } finally {
        committedFile.close();
      }
    } else {
      const directoryHandle = await Deno.open(directory, { read: true });
      try {
        await directoryHandle.sync();
      } finally {
        directoryHandle.close();
      }
    }
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch {
      // Preserve the primary persistence error; an orphaned random temporary file is harmless.
    }
    throw error;
  }
}

export class FileWalletRepository implements WalletRepository {
  readonly directory: string;
  readonly statePath: string;
  readonly secretPath: string;

  constructor(directory = defaultWalletDataDirectory()) {
    const separator = Deno.build.os === "windows" ? "\\" : "/";
    this.directory = directory.replace(/[\\/]$/u, "");
    this.statePath = `${this.directory}${separator}wallet.json`;
    this.secretPath = `${this.directory}${separator}secret.json`;
  }

  async loadState(): Promise<WalletPublicState> {
    return parseWalletState(await readJson(this.statePath));
  }

  saveState(state: WalletPublicState): Promise<void> {
    return writeJsonAtomically(this.statePath, state);
  }

  async loadSecret(): Promise<SecretRecord | null> {
    return await readJson(this.secretPath) as SecretRecord | null;
  }

  saveSecret(secret: SecretRecord): Promise<void> {
    return writeJsonAtomically(this.secretPath, secret);
  }

  async exists(): Promise<boolean> {
    return (await this.loadSecret()) !== null;
  }
}
