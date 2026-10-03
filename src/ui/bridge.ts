import type {
  BpubPreview,
  BpubPreviewRequest,
  BroadcastResult,
  CreateWalletRequest,
  ReplayPreview,
  RestoreWalletRequest,
  SpendPreview,
  SpendPreviewRequest,
  WalletSettingsUpdate,
  WalletSnapshot,
} from "../core/types.ts";
import type { CreatedWallet } from "../core/wallet_service.ts";

interface WalletBindings {
  walletRpc(request: { method: string; payload?: unknown }): Promise<unknown>;
}

const BROWSER_CAPABILITY_KEY = "bcashjr-rpc-capability";
const SESSION_EXPIRED_MESSAGE =
  "Wallet session expired after the server restarted. Open the new private wallet URL printed in the terminal.";

function browserCapability(): string {
  const fragment = new URLSearchParams(location.hash.replace(/^#/u, "")).get("rpc");
  if (fragment) {
    sessionStorage.setItem(BROWSER_CAPABILITY_KEY, fragment);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fragment;
  }
  const stored = sessionStorage.getItem(BROWSER_CAPABILITY_KEY);
  if (!stored) throw new Error("Open the private wallet URL printed by BcashJr Wallet");
  return stored;
}

async function call<T>(method: string, payload?: unknown): Promise<T> {
  const bindings = (globalThis as unknown as { bindings?: WalletBindings }).bindings;
  if (bindings?.walletRpc) {
    return await bindings.walletRpc({ method, payload }) as T;
  }
  const response = await fetch("/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bcashjr-capability": browserCapability(),
    },
    body: JSON.stringify({ method, payload }),
  });
  const body = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    if (response.status === 403) {
      sessionStorage.removeItem(BROWSER_CAPABILITY_KEY);
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`Wallet RPC returned an invalid response (HTTP ${response.status})`);
  }
  if (
    !value || typeof value !== "object" ||
    typeof (value as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new Error(`Wallet RPC returned a malformed response (HTTP ${response.status})`);
  }
  const envelope = value as { ok: boolean; result?: T; error?: unknown };
  if (response.status === 403) sessionStorage.removeItem(BROWSER_CAPABILITY_KEY);
  if (!envelope.ok || !response.ok) {
    throw new Error(
      typeof envelope.error === "string"
        ? envelope.error
        : response.status === 403
        ? SESSION_EXPIRED_MESSAGE
        : `Wallet request failed (HTTP ${response.status})`,
    );
  }
  return envelope.result as T;
}

export const walletApi = {
  previewBpub: (request: BpubPreviewRequest) => call<BpubPreview>("previewBpub", request),
  confirmBpub: (id: string, acceptHighFee = false) =>
    call<WalletSnapshot>("confirmBpub", { id, acceptHighFee }),
  cancelBpubPreview: (id: string) => call<void>("cancelBpubPreview", { id }),
  resumeBpub: (id: string) => call<WalletSnapshot>("resumeBpub", { id }),
  snapshot: () => call<WalletSnapshot>("snapshot"),
  createWallet: (request: CreateWalletRequest) => call<CreatedWallet>("createWallet", request),
  restoreWallet: (request: RestoreWalletRequest) => call<CreatedWallet>("restoreWallet", request),
  unlock: (password: string) => call<WalletSnapshot>("unlock", { password }),
  recoveryPhrase: () => call<string>("recoveryPhrase"),
  acknowledgeRecoveryPhrase: () => call<WalletSnapshot>("acknowledgeRecoveryPhrase"),
  lock: () => call<WalletSnapshot>("lock"),
  newReceiveAddress: () => call<WalletSnapshot>("newReceiveAddress"),
  sync: () => call<WalletSnapshot>("sync"),
  fullRescan: () => call<WalletSnapshot>("fullRescan"),
  updateSettings: (settings: WalletSettingsUpdate) =>
    call<WalletSnapshot>("updateSettings", settings),
  previewSpend: (request: SpendPreviewRequest) => call<SpendPreview>("previewSpend", request),
  confirmSpend: (id: string, acceptHighFee = false, acceptReplayRisk = false) =>
    call<BroadcastResult>("confirmSpend", { id, acceptHighFee, acceptReplayRisk }),
  cancelSpendPreview: (id: string) => call<void>("cancelSpendPreview", { id }),
  previewReplay: (txid: string) => call<ReplayPreview>("previewReplay", { txid }),
  confirmReplay: (id: string) => call<BroadcastResult>("confirmReplay", { id }),
  cancelReplayPreview: (id: string) => call<void>("cancelReplayPreview", { id }),
  rebroadcastIntent: (id: string) => call<BroadcastResult>("rebroadcastIntent", { id }),
  abandonIntent: (id: string) => call<WalletSnapshot>("abandonIntent", { id }),
};
