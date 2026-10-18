import { base64 } from "@scure/base";
import { RawTx } from "@scure/btc-signer";
import { decodeBpub } from "../../src/bpub/mod.ts";
import { bpubCompression } from "../../src/core/bpub_transaction.ts";
import { fromHex, toHex } from "../../src/core/bytes.ts";
import { ChainVerifier } from "../../src/core/chain_verifier.ts";
import { Bip86Keychain, protectEntropy } from "../../src/core/keys.ts";
import { FileWalletRepository } from "../../src/core/storage.ts";
import { emptyPublicState } from "../../src/core/types.ts";
import { WalletService } from "../../src/core/wallet_service.ts";
import { assert, eventually, picture, regtestAddress, RegtestClient, Rpc } from "./helpers.ts";

Deno.test({
  name: "Docker regtest: receiving, replay-protected splitting, and BPUB relay/confirmation",
  ignore: Deno.env.get("BCASHJR_INTEGRATION") !== "1",
  async fn(t) {
    const step = async (name: string, fn: () => Promise<void>) => {
      assert(await t.step(name, fn), `Integration step failed: ${name}`);
    };
    const btc = new Rpc(Deno.env.get("BTC_RPC")!);
    const blake = new Rpc(Deno.env.get("BLAKE_RPC")!);
    const clients = {
      btc: new RegtestClient(Deno.env.get("BTC_API")!),
      blake: new RegtestClient(Deno.env.get("BLAKE_API")!),
    };
    const keys = new Bip86Keychain(new Uint8Array(16));
    const receive = keys.derive(0, 0);
    const destination = keys.derive(0, 1);
    keys.destroy();
    const directory = await Deno.makeTempDir({ prefix: "bcashjr-regtest-" });
    const repo = new FileWalletRepository(directory);
    let service: WalletService | undefined;
    try {
      await eventually("Core RPC", () => btc.call("getblockchaininfo"), () => true);
      await eventually("Knots RPC", () => blake.call("getblockchaininfo"), () => true);
      await btc.call("createwallet", ["miner"]);
      const miner = await btc.call<string>("getnewaddress", [], "miner");
      // Import the exact pre-fork blocks, including funding, into Knots. This gives
      // both chains real identical outpoints, not two unrelated faucet payments.
      const sharedBlocks = async (count: number) => {
        const hashes = await btc.call<string[]>("generatetoaddress", [count, miner]);
        for (const hash of hashes) {
          const raw = await btc.call<string>("getblock", [hash, 0]);
          assert(
            await blake.call("submitblock", [raw]) === null,
            "Knots rejected a pre-fork block",
          );
        }
      };
      await sharedBlocks(101);
      const deposit = await btc.call<string>(
        "sendtoaddress",
        [regtestAddress(receive.address), 1],
        "miner",
      );
      await sharedBlocks(8); // height 109; hardfork activates at 110
      await btc.call("generatetoaddress", [1, miner]);
      const fork = await blake.call<string[]>("generatetoaddress", [1, miner]);
      const btcCheckpoint = await btc.call<string>("getblockhash", [110]);
      assert(fork[0] !== btcCheckpoint, "Chains did not fork");
      assert(
        (await blake.call<string>("getblockheader", [fork[0], false])).length === 328,
        "Knots did not activate the 164-byte BLAKE header",
      );
      const template = await blake.call<{ weightlimit: number }>("getblocktemplate", [
        { rules: ["segwit", "blake2b"] },
      ]);
      assert(template.weightlimit === 800000, "Reduced-data block rules are not active");
      const verifier = () =>
        new ChainVerifier({
          btc: { height: 110, hash: btcCheckpoint },
          blake: { height: 110, hash: fork[0] },
        });
      const state = emptyPublicState();
      state.recoveryPhraseAcknowledged = true;
      state.settings.btcApiUrl = clients.btc.baseUrl;
      state.settings.blakeApiUrl = clients.blake.baseUrl;
      state.settings.scanGap = 2;
      await repo.saveState(state);
      await repo.saveSecret(await protectEntropy(new Uint8Array(16), "regtest-password"));
      const open = async () => {
        const wallet = new WalletService(repo, (c) => clients[c], Date.now, verifier());
        await wallet.initialize();
        await wallet.unlock("regtest-password");
        return wallet;
      };
      service = await open();
      const sync = () => service!.sync();
      let source = "";
      await step("receives the shared deposit through both real explorer backends", async () => {
        await eventually("both explorer indexes", () =>
          Promise.all([
            clients.btc.addressUtxos(receive.address),
            clients.blake.addressUtxos(receive.address),
          ]), (v) => v.every((coins) => coins.some((c) => c.txid === deposit)));
        const s = await eventually(
          "wallet recovery",
          sync,
          (s) => s.recoveryScanComplete && s.splittableOutpoints.length === 1,
        );
        assert(
          s.balances.btc === 100_000_000 && s.balances.blake === 100_000_000,
          "Wrong received balances",
        );
        source = s.splittableOutpoints[0];
      });
      let splitId = "";
      await step("splits on Knots and rejects the same signed spend on Core", async () => {
        const preview = await service!.previewSpend({
          chain: "blake",
          purpose: "split",
          outpoints: [source],
          destination: destination.address,
          feeRate: 2,
        });
        const split = await service!.confirmSpend(preview.id);
        splitId = split.txid;
        await blake.call("getmempoolentry", [split.txid]);
        const [rejected] = await btc.call<Array<{ allowed: boolean; "reject-reason": string }>>(
          "testmempoolaccept",
          [[split.rawTx]],
        );
        assert(
          !rejected.allowed && /signature|sighash/i.test(rejected["reject-reason"]),
          `Core rejected for an unexpected reason: ${JSON.stringify(rejected)}`,
        );
        await service!.updateSettings({ blakeConfirmations: 0 });
        await eventually(
          "unconfirmed split output",
          sync,
          (s) => s.selectableBlakeOutpoints.some((o) => o.startsWith(splitId)),
        );
        let blocked = false;
        try {
          await service!.previewBpub({
            filename: "unconfirmed.gif",
            mime: "image/gif",
            dataBase64: base64.encode(picture(100)),
            outpoints: service!.snapshot().selectableBlakeOutpoints.filter((o) =>
              o.startsWith(splitId)
            ),
            feeRate: 2,
          });
        } catch (error) {
          assert(
            String(error).includes("at least one BLAKE confirmation"),
            `Unexpected publication rejection: ${error}`,
          );
          blocked = true;
        }
        assert(blocked, "BPUB accepted an unconfirmed input with zero confirmations configured");
        await blake.call("generatetoaddress", [1, miner]);
        const [sourceTx, sourceIndex] = source.split(":");
        assert(
          await btc.call("gettxout", [sourceTx, Number(sourceIndex)]) !== null,
          "Split consumed BTC",
        );
        assert(
          await blake.call("gettxout", [sourceTx, Number(sourceIndex)]) === null,
          "Split did not consume BLAKE",
        );
        await eventually(
          "split confirmation",
          sync,
          (s) =>
            s.outputs.some((o) =>
              o.txid === splitId && o.blake.tx?.confirmed && o.blake.tx.confirmations >= 1
            ),
        );
      });
      await step(
        "500-input BPUB waits, survives restart, is accepted and recovers exact bytes",
        async () => {
          const data = picture(216800);
          const s = service!.snapshot();
          const preview = await service!.previewBpub({
            filename: "regtest.gif",
            mime: "image/gif",
            dataBase64: base64.encode(data),
            outpoints: s.selectableBlakeOutpoints.filter((o) => o.startsWith(splitId)),
            feeRate: 2,
          });
          assert(preview.dataOutputCount === 500, "Fixture did not reach the input boundary");
          await service!.confirmBpub(preview.id);
          const saved = await repo.loadState();
          const publication = saved.publications[0];
          const funding = saved.intents.find((i) => i.id === publication.fundingIntentId)!;
          const reveal = saved.intents.find((i) => i.id === publication.revealIntentId)!;
          assert(
            reveal.phase === "prepared" && !reveal.broadcastStartedAt,
            "Reveal was broadcast before funding confirmation",
          );
          await blake.call("getmempoolentry", [funding.txid]);
          const [tooLarge] = await blake.call<Array<{ allowed: boolean; "reject-reason": string }>>(
            "testmempoolaccept",
            [[reveal.rawTx]],
          );
          assert(
            !tooLarge.allowed && /chain|ancestor|descendant/.test(tooLarge["reject-reason"]),
            `Expected ancestor rejection: ${JSON.stringify(tooLarge)}`,
          );
          await service!.lock();
          service = await open();
          assert(
            service.snapshot().publications[0].waitingForFundingConfirmation,
            "Restart lost waiting state",
          );
          await service.resumeBpub(preview.id);
          assert(
            (await repo.loadState()).intents.find((i) => i.id === reveal.id)!.phase === "prepared",
            "Resume exposed reveal early",
          );
          await blake.call("generatetoaddress", [1, miner]);
          const [accepted] = await blake.call<Array<{ allowed: boolean }>>("testmempoolaccept", [[
            reveal.rawTx,
          ]]);
          assert(accepted.allowed, `Knots rejected funded BPUB: ${JSON.stringify(accepted)}`);
          await eventually(
            "funding confirmation",
            sync,
            (s) => s.publications[0].fundingPhase === "confirmed",
          );
          await service.resumeBpub(preview.id);
          await blake.call("getmempoolentry", [reveal.txid]);
          assert(
            await clients.blake.transactionHex(reveal.txid) === reveal.rawTx,
            "Explorer returned different reveal bytes",
          );
          await blake.call("generatetoaddress", [1, miner]);
          await eventually(
            "reveal confirmation",
            sync,
            (s) => s.publications[0].revealPhase === "confirmed",
          );
          const raw = RawTx.decode(fromHex(await clients.blake.transactionHex(reveal.txid)));
          const dataKeys = raw.witnesses!.flatMap((w) => {
            const script = w[2];
            const result: Uint8Array[] = [];
            for (let offset = 1; offset < script.length - 36; offset += 34) {
              result.push(script.slice(offset + 1, offset + 34));
            }
            return result;
          });
          assert(
            toHex(decodeBpub(dataKeys, bpubCompression, data.length).data) === toHex(data),
            "Published content changed",
          );
          // Completed publications deliberately stop displaying stale ownership balances.
          // Verify the actual unspent reserve on the node instead.
          const owner = await blake.call<{ value: number } | null>("gettxout", [
            funding.txid,
            preview.dataOutputCount,
          ]);
          assert(owner !== null && Math.round(owner.value * 1e8) === 330, "Ownership output lost");
          assert(
            !service.snapshot().selectableBlakeOutpoints.includes(
              `${funding.txid}:${preview.dataOutputCount}`,
            ),
            "Ownership reserve became ordinary spendable funds",
          );
          const btcPool = await btc.call<string[]>("getrawmempool");
          assert(
            !btcPool.includes(funding.txid) && !btcPool.includes(reveal.txid),
            "Publication reached BTC",
          );
        },
      );
      await step(
        "spends the remaining BTC independently after confirmed split protection",
        async () => {
          const preview = await service!.previewSpend({
            chain: "btc",
            purpose: "send",
            outpoints: [source],
            destination: destination.address,
            feeRate: 2,
          });
          const spend = await service!.confirmSpend(preview.id);
          await btc.call("getmempoolentry", [spend.txid]);
          await btc.call("generatetoaddress", [1, miner]);
          await eventually(
            "BTC spend confirmation",
            sync,
            (s) => s.outputs.some((o) => o.txid === spend.txid && o.btc.tx?.confirmed),
          );
          const [sourceTx, sourceIndex] = source.split(":");
          assert(
            await btc.call("gettxout", [sourceTx, Number(sourceIndex)]) === null,
            "BTC send did not consume its source",
          );
        },
      );
    } finally {
      await service?.lock();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
