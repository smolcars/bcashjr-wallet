import { Bip86Keychain, entropyFromMnemonic } from "../core/keys.ts";
import { createSweepTemplate } from "../core/transaction.ts";
import type { SpendPreviewRequest } from "../core/types.ts";
import { desktopJsonHandler } from "../desktop_json.ts";
import { walletApi } from "./bridge.ts";

Deno.test("wallet desktop bridge previews fractional BLAKE fees using strings in both directions", async () => {
  const entropy = entropyFromMnemonic(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  );
  const keychain = new Bip86Keychain(entropy);
  const originalBindings = Object.getOwnPropertyDescriptor(globalThis, "bindings");
  try {
    const source = keychain.derive(0, 0);
    const coin = {
      txid: "11".repeat(32),
      vout: 0,
      value: 100_000,
      scriptPubKey: source.scriptPubKey,
      path: source.path,
    };
    const handler = desktopJsonHandler(
      ({ method, payload }: { method: string; payload: SpendPreviewRequest }) => {
        if (method !== "previewSpend") throw new Error("Wrong method dispatched");
        const template = createSweepTemplate(
          [coin],
          payload.destination,
          payload.feeRate!,
          900_000,
        );
        return {
          feeRate: template.feeRate,
          fee: template.fee,
          outputValue: template.outputValue,
          vsize: template.vsize,
        };
      },
    );
    Object.defineProperty(globalThis, "bindings", {
      configurable: true,
      value: {
        walletRpc: async (request: string) => {
          if (typeof request !== "string") throw new Error("Native bridge received an object");
          const response = await handler(request);
          if (typeof response !== "string") throw new Error("Native bridge returned an object");
          return response;
        },
      },
    });
    for (const [feeRate, expectedFee] of [[1, 112], [1.1, 124], [1.5, 168], [2, 224]]) {
      const preview = await walletApi.previewSpend({
        chain: "blake",
        purpose: "split",
        outpoints: [`${coin.txid}:0`],
        destination: source.address,
        feeRate,
      });
      if (
        preview.feeRate !== feeRate || preview.fee !== expectedFee ||
        preview.outputValue !== coin.value - expectedFee || preview.vsize !== 112
      ) throw new Error(`Incorrect split preview at ${feeRate} sat/vB`);
    }
  } finally {
    if (originalBindings) Object.defineProperty(globalThis, "bindings", originalBindings);
    else Reflect.deleteProperty(globalThis, "bindings");
    keychain.destroy();
    entropy.fill(0);
  }
});
