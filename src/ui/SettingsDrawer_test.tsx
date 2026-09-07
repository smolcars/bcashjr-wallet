import { renderToStaticMarkup } from "react-dom/server";
import { emptyPublicState } from "../core/types.ts";
import { buildWalletSnapshot } from "../core/wallet_snapshot.ts";
import { SettingsDrawer } from "./SettingsDrawer.tsx";

Deno.test("settings offer BIP177 without selecting it by default", () => {
  const state = emptyPublicState();
  const render = () =>
    renderToStaticMarkup(
      <SettingsDrawer
        snapshot={buildWalletSnapshot(state, "unlocked")}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
  const defaults = render();
  if (
    !defaults.includes('<option value="btc" selected="">BTC</option>') ||
    !defaults.includes('<option value="bip177">Bitcoin (BIP177)</option>')
  ) throw new Error("BIP177 must be available without changing the BTC default");

  state.settings.amountUnit = "bip177";
  const selected = render();
  if (
    !selected.includes('<option value="bip177" selected="">Bitcoin (BIP177)</option>')
  ) throw new Error("Settings did not reflect the selected BIP177 unit");
});
