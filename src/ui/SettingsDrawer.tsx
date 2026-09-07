import { type FormEvent, useState } from "react";
import type { AmountUnit, WalletSettings, WalletSnapshot } from "../core/types.ts";
import { walletApi } from "./bridge.ts";
import { errorMessage, Spinner } from "./shared.tsx";

interface SettingsDrawerProps {
  snapshot: WalletSnapshot;
  onClose(): void;
  onSave(snapshot: WalletSnapshot): void;
}

export function SettingsDrawer({ snapshot, onClose, onSave }: SettingsDrawerProps) {
  const [settings, setSettings] = useState(snapshot.settings);
  const [busy, setBusy] = useState<"" | "save" | "rescan">("");
  const [error, setError] = useState("");

  function patch<K extends keyof WalletSettings>(key: K, value: WalletSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    try {
      onSave(
        await walletApi.updateSettings({
          ...settings,
          btcFeeRate: settings.btcFeeRate ?? null,
          blakeFeeRate: settings.blakeFeeRate ?? null,
        }),
      );
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function fullRescan() {
    if (
      !globalThis.confirm(
        "Restart address discovery from index 0 using the saved Esplora settings? Existing coins and transaction recovery records will be kept.",
      )
    ) return;
    setBusy("rescan");
    setError("");
    try {
      onSave(await walletApi.fullRescan());
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <div className="eyebrow">CONFIGURATION</div>
            <h2>Settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>
        <form onSubmit={save}>
          <label>
            BTC Esplora URL<input
              value={settings.btcApiUrl}
              onChange={(event) => patch("btcApiUrl", event.target.value)}
            />
          </label>
          <label>
            BLAKE Esplora URL<input
              value={settings.blakeApiUrl}
              onChange={(event) => patch("blakeApiUrl", event.target.value)}
            />
          </label>
          <label>
            Display amounts
            <select
              value={settings.amountUnit}
              onChange={(event) => patch("amountUnit", event.target.value as AmountUnit)}
            >
              <option value="sat">Sats</option>
              <option value="btc">BTC</option>
              <option value="bip177">Bitcoin (BIP177)</option>
            </select>
          </label>
          <div className="two-col">
            <label>
              BTC confirmations
              <input
                type="number"
                min="0"
                max="1000"
                step="1"
                value={settings.btcConfirmations}
                onChange={(event) => patch("btcConfirmations", Number(event.target.value))}
              />
            </label>
            <label>
              BLAKE confirmations
              <input
                type="number"
                min="0"
                max="1000"
                step="1"
                value={settings.blakeConfirmations}
                onChange={(event) => patch("blakeConfirmations", Number(event.target.value))}
              />
              <small className="field-help">
                Also required for split protection before BTC replay warnings are cleared.
              </small>
            </label>
          </div>
          <small className="field-help">
            0 allows unconfirmed UTXOs. Split protection always needs at least 1 confirmation.
          </small>
          <label>
            Address gap<input
              type="number"
              min="1"
              value={settings.scanGap}
              onChange={(event) => patch("scanGap", Number(event.target.value))}
            />
          </label>
          <div className="two-col">
            <label>
              BTC default fee rate <span className="optional">sat/vB</span>
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={settings.btcFeeRate ?? ""}
                onChange={(event) =>
                  patch(
                    "btcFeeRate",
                    event.target.value ? Number(event.target.value) : undefined,
                  )}
                placeholder="Automatic — BTC API"
              />
            </label>
            <label>
              BLAKE default fee rate <span className="optional">sat/vB</span>
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={settings.blakeFeeRate ?? ""}
                onChange={(event) =>
                  patch(
                    "blakeFeeRate",
                    event.target.value ? Number(event.target.value) : undefined,
                  )}
                placeholder="Automatic — BLAKE API"
              />
            </label>
          </div>
          {error && <div className="error-box">{error}</div>}
          <button type="submit" className="primary wide" disabled={Boolean(busy)}>
            {busy === "save" && <Spinner />}Save settings
          </button>
        </form>
        <section className="settings-maintenance">
          <div>
            <h3>Wallet scan</h3>
            <p>
              Recheck address history from index 0 using the saved Esplora settings. Existing coins
              and transaction recovery records are preserved. Large wallets may require additional
              scan passes.
            </p>
          </div>
          <button
            type="button"
            className="secondary wide"
            disabled={Boolean(busy)}
            onClick={fullRescan}
          >
            {busy === "rescan" && <Spinner />}Start full rescan
          </button>
        </section>
      </aside>
    </div>
  );
}
