import { RawTx, Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { fromHex, toHex } from "./bytes.ts";
import { Bip86Keychain, protectEntropy } from "./keys.ts";
import { EsploraClient, type EsploraTxStatus, type EsploraUtxo } from "./esplora.ts";
import { MemoryWalletRepository, parseWalletState } from "./storage.ts";
import { type ChainId, emptyPublicState, type WalletPublicState } from "./types.ts";
import { WalletService } from "./wallet_service.ts";

const SOURCE = "11".repeat(32);
const PASSWORD = "bpub-test-password";
const picture = {
  filename: "test.gif",
  mime: "image/gif",
  dataBase64: base64.encode(new TextEncoder().encode("GIF89a" + "test".repeat(500))),
};
const assert = (value: unknown, message = "Assertion failed") => {
  if (!value) throw new Error(message);
};
async function rejects(fn: () => Promise<unknown>) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, "Expected rejection");
}
class Repo extends MemoryWalletRepository {
  failPrepared = false;
  failRevealMarker = false;
  override saveState(state: WalletPublicState): Promise<void> {
    if (this.failPrepared && state.publications.length) {
      return Promise.reject(new Error("Disk full"));
    }
    if (
      this.failRevealMarker &&
      state.intents.some((i) => i.kind === "blake-bpub-reveal" && i.broadcastStartedAt)
    ) {
      return Promise.reject(new Error("Reveal marker write failed"));
    }
    return super.saveState(state);
  }
}
class Client extends EsploraClient {
  statuses = new Map<string, EsploraTxStatus>([[SOURCE, {
    confirmed: true,
    block_height: 961645,
  }]]);
  raw = new Map<string, string>();
  posts: string[] = [];
  failPost = 0;
  acceptThenTimeout = false;
  checkpointFailure = false;
  statusFailure = false;
  statusCalls = 0;
  outspendFailure = false;
  outspendCalls = 0;
  beforePost?: () => Promise<void>;
  constructor(readonly chain: ChainId, readonly walletAddress: string, readonly script: string) {
    super(`https://${chain}.invalid`);
  }
  override tipHeight() {
    return Promise.resolve(961650);
  }
  override blockHash() {
    return Promise.resolve(
      this.checkpointFailure
        ? "00".repeat(32)
        : this.chain === "blake"
        ? "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb"
        : "00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00",
    );
  }
  override transactionStatus(id: string, rawTx?: string) {
    this.statusCalls++;
    if (this.statusFailure) return Promise.reject(new Error(`${this.chain} backend unavailable`));
    // Exercise the real HTTP response parser, including the backend's misleading /status response.
    const client = new EsploraClient(this.baseUrl, (input, init) => {
      const path = new URL(String(input)).pathname;
      const status = this.statuses.get(id);
      if (path.endsWith("/status")) {
        return Promise.resolve(Response.json(status ?? { confirmed: false }));
      }
      if (path.endsWith("/txs/test")) {
        assert(init?.method === "POST", "Mempool acceptance must use POST");
        assert(init?.body === JSON.stringify([rawTx]), "Mempool acceptance tested the wrong hex");
        return Promise.resolve(Response.json([{
          txid: id,
          wtxid: id,
          allowed: !(status && this.raw.has(id)),
          "reject-reason": status && this.raw.has(id) ? "txn-already-in-mempool" : null,
        }]));
      }
      assert(path === `/tx/${id}/hex`, "Unexpected status lookup endpoint");
      return Promise.resolve(
        status && this.raw.has(id)
          ? new Response(this.raw.get(id))
          : new Response("Transaction not found", { status: 404 }),
      );
    });
    return client.transactionStatus(id, rawTx);
  }
  override transactionHex(id: string) {
    return Promise.resolve(this.raw.get(id) ?? "");
  }
  override recommendedFees() {
    return Promise.resolve({ fastestFee: 3 });
  }
  override address(address: string) {
    const stats = {
      funded_txo_count: address === this.walletAddress ? 1 : 0,
      funded_txo_sum: 100000,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: address === this.walletAddress ? 1 : 0,
    };
    return Promise.resolve({
      address,
      chain_stats: stats,
      mempool_stats: { ...stats, tx_count: 0 },
    });
  }
  override addressUtxos(address: string): Promise<EsploraUtxo[]> {
    if (address !== this.walletAddress) return Promise.resolve([]);
    const spent = new Set<string>();
    const outputs: EsploraUtxo[] = [{
      txid: SOURCE,
      vout: 0,
      value: 100000,
      status: this.statuses.get(SOURCE)!,
    }];
    for (const [txid, raw] of this.raw) {
      const tx = RawTx.decode(fromHex(raw));
      tx.inputs.forEach((i) => spent.add(`${toHex(i.txid)}:${i.index}`));
      tx.outputs.forEach((o, vout) => {
        if (toHex(o.script) === this.script) {
          outputs.push({ txid, vout, value: Number(o.amount), status: this.statuses.get(txid)! });
        }
      });
    }
    return Promise.resolve(outputs.filter((o) => !spent.has(`${o.txid}:${o.vout}`)));
  }
  override transactionOutspends(txid: string) {
    this.outspendCalls++;
    if (this.outspendFailure) return Promise.reject(new Error("429"));
    const tx = RawTx.decode(fromHex(this.raw.get(txid)!));
    const spends = tx.outputs.map((): { spent: boolean; txid?: string } => ({ spent: false }));
    for (const [id, raw] of this.raw) {
      for (const i of RawTx.decode(fromHex(raw)).inputs) {
        if (toHex(i.txid) === txid) spends[i.index] = { spent: true, txid: id };
      }
    }
    return Promise.resolve(spends);
  }
  override async broadcast(raw: string) {
    await this.beforePost?.();
    this.posts.push(raw);
    const id =
      Transaction.fromRaw(fromHex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
    const fail = this.posts.length === this.failPost;
    if (!fail || this.acceptThenTimeout) {
      this.raw.set(id, raw);
      this.statuses.set(id, { confirmed: false });
    }
    if (fail) throw new Error("Timed out");
    return id;
  }
}
let secret: ReturnType<typeof protectEntropy> | undefined;
async function fixture() {
  const keys = new Bip86Keychain(new Uint8Array(16));
  const address = keys.derive(0, 0);
  keys.destroy();
  const state = emptyPublicState();
  state.recoveryPhraseAcknowledged = true;
  state.recoveryScanComplete = true;
  state.addresses = [address];
  state.nextReceiveIndex = 1;
  const observed = {
    checkedAt: new Date().toISOString(),
    backendOk: true,
    tx: { present: true, confirmed: true, confirmations: 6 },
    unspent: true,
  };
  state.coins = [{
    ...address,
    txid: SOURCE,
    outpoint: `${SOURCE}:0`,
    vout: 0,
    value: 100000,
    blake: structuredClone(observed),
    btc: structuredClone(observed),
  }];
  state.sharedProvenance[`${SOURCE}:0`] = { firstObservedAt: observed.checkedAt };
  state.tips = {
    blake: { height: 961650, fetchedAt: observed.checkedAt },
    btc: { height: 961650, fetchedAt: observed.checkedAt },
  };
  const repo = new Repo(state);
  secret ??= protectEntropy(new Uint8Array(16), PASSWORD);
  await repo.saveSecret(await secret);
  const blake = new Client("blake", address.address, address.scriptPubKey);
  const btc = new Client("btc", address.address, address.scriptPubKey);
  const service = new WalletService(repo, (chain) => chain === "blake" ? blake : btc);
  await service.initialize();
  await service.unlock(PASSWORD);
  const request = { ...picture, outpoints: [`${SOURCE}:0`], feeRate: 3 };
  return { repo, blake, btc, service, request };
}
Deno.test("BPUB persists both signed transactions before POST and never broadcasts BTC", async () => {
  const f = await fixture();
  f.blake.beforePost = async () => {
    const saved = await f.repo.loadState();
    assert(
      saved.publications.length === 1 && saved.intents.length === 2,
      "Pair not saved before POST",
    );
    parseWalletState(saved);
  };
  const preview = await f.service.previewBpub(f.request);
  assert(f.blake.posts.length === 0);
  const snapshot = await f.service.confirmBpub(preview.id);
  assert(f.blake.posts.length === 2 && f.btc.posts.length === 0);
  assert(
    snapshot.publications[0].dataUnspent === 0 && snapshot.publications[0].ownerUnspent === 330,
  );
  assert(
    !JSON.stringify(snapshot).includes("witnessScripts") &&
      !JSON.stringify(snapshot).includes("rawTx"),
  );
  await rejects(() => f.service.confirmBpub(preview.id));
  for (const intent of (await f.repo.loadState()).intents) {
    await rejects(() => f.service.abandonIntent(intent.id));
  }
  await f.service.sync();
  assert(f.blake.posts.length === 2, "Sync broadcast unexpectedly");
  assert(f.service.snapshot().outputs.every((o) => o.scriptPubKey.startsWith("5120")));
  await f.service.lock();
  assert(f.service.snapshot().publications.length === 0);
});
Deno.test("BPUB funding timeout resumes after restart without creating another pair", async () => {
  const f = await fixture();
  f.blake.failPost = 1;
  f.blake.acceptThenTimeout = true;
  const preview = await f.service.previewBpub(f.request);
  await rejects(() => f.service.confirmBpub(preview.id));
  assert(f.blake.posts.length === 1);
  const saved = await f.repo.loadState();
  const originalFunding = saved.intents[0].rawTx;
  const originalReveal = saved.intents[1].rawTx;
  const restarted = new WalletService(f.repo, (chain) => chain === "blake" ? f.blake : f.btc);
  await restarted.initialize();
  await restarted.unlock(PASSWORD);
  await restarted.resumeBpub(preview.id);
  assert(
    f.blake.posts.length === 2 && f.blake.posts[0] === originalFunding &&
      f.blake.posts[1] === originalReveal,
  );
  await restarted.resumeBpub(preview.id);
  assert(f.blake.posts.length === 2, "Resume duplicated an accepted broadcast");
});

Deno.test("BPUB reveal resume does not depend on the BTC backend", async () => {
  const f = await fixture();
  const preview = await f.service.previewBpub(f.request);
  f.blake.failPost = 2;
  await rejects(() => f.service.confirmBpub(preview.id));

  const saved = await f.repo.loadState();
  const funding = saved.intents.find((intent) => intent.kind === "blake-unified")!;
  const now = new Date().toISOString();
  saved.intents.push({
    id: "00000000-0000-4000-8000-000000000099",
    kind: "btc-spend",
    chain: "btc",
    txid: funding.txid,
    rawTx: funding.rawTx,
    createdAt: now,
    phase: "confirmed",
    broadcastStartedAt: now,
    lastBroadcastAt: now,
    lastObservation: {
      checkedAt: now,
      backendOk: true,
      tx: { present: true, confirmed: true, confirmations: 1 },
    },
    inputOutpoints: [...funding.inputOutpoints],
  });
  await f.repo.saveState(saved);
  await f.service.lock();

  const restarted = new WalletService(f.repo, (chain) => chain === "blake" ? f.blake : f.btc);
  await restarted.initialize();
  await restarted.unlock(PASSWORD);
  f.btc.statusCalls = 0;
  f.btc.statusFailure = true;
  await restarted.resumeBpub(preview.id);

  assert(f.btc.statusCalls === 0, "BLAKE reveal resume queried the BTC backend");
  assert(restarted.snapshot().publications[0].revealPhase === "seen");
});

Deno.test("resurfaced BLAKE send supersedes publication without breaking Sync or exposing reveal", async () => {
  const f = await fixture();
  f.blake.failPost = 1;
  const send = await f.service.previewSpend({
    chain: "blake",
    purpose: "split",
    outpoints: f.request.outpoints,
    destination: f.blake.walletAddress,
    feeRate: 3,
  });
  await rejects(() => f.service.confirmSpend(send.id));
  const original = (await f.repo.loadState()).intents[0];
  assert(original.kind === "blake-unified");
  assert(original.broadcastStartedAt, "Original send was not exposed");
  await f.service.sync();
  assert(f.service.snapshot().intents.find((i) => i.id === original.id)?.phase === "recoverable");
  await f.service.abandonIntent(original.id);

  const preview = await f.service.previewBpub(f.request);
  f.blake.failPost = 2;
  await rejects(() => f.service.confirmBpub(preview.id));
  const postsBeforeSync = f.blake.posts.length;
  assert(postsBeforeSync === 2, "Publication funding should have timed out");

  f.blake.raw.set(original.txid, original.rawTx);
  f.blake.statuses.set(original.txid, { confirmed: true, block_height: 961649 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await f.service.sync();
    const publication = snapshot.publications[0];
    assert(!snapshot.lastSyncError, "Supersession must not break Sync");
    assert(publication.fundingPhase === "abandoned" && publication.revealPhase === "prepared");
    assert(publication.lastError?.includes("picture was not published"));
    assert(f.blake.posts.length === postsBeforeSync, "Sync broadcast a superseded transaction");
  }
  const saved = await f.repo.loadState();
  parseWalletState(saved);
  await rejects(() => f.service.resumeBpub(preview.id));
  await rejects(() => f.service.abandonIntent(saved.publications[0].fundingIntentId));
  assert(f.blake.posts.length === postsBeforeSync, "Resume broadcast a superseded transaction");

  const restarted = new WalletService(f.repo, (chain) => chain === "blake" ? f.blake : f.btc);
  await restarted.initialize();
  await restarted.unlock(PASSWORD);
  const snapshot = await restarted.sync();
  assert(!snapshot.lastSyncError && snapshot.publications[0].fundingPhase === "abandoned");
  assert(snapshot.publications[0].revealPhase === "prepared");

  // A reorg can reverse the winner. The saved reveal must remain usable if funding appears.
  const funding = saved.intents.find((i) => i.id === saved.publications[0].fundingIntentId)!;
  f.blake.raw.delete(original.txid);
  f.blake.statuses.delete(original.txid);
  f.blake.raw.set(funding.txid, funding.rawTx);
  f.blake.statuses.set(funding.txid, { confirmed: true, block_height: 961649 });
  const restored = await restarted.sync();
  assert(!restored.lastSyncError && restored.publications[0].fundingPhase === "confirmed");
  assert(restored.publications[0].revealPhase === "prepared");
  await restarted.resumeBpub(preview.id);
  assert(f.blake.posts.length === postsBeforeSync + 1, "The saved reveal did not resume");
});

Deno.test("BPUB resumes the same saved pair after correcting falsely seen observations", async () => {
  const f = await fixture();
  const preview = await f.service.previewBpub(f.request);
  f.blake.failPost = 1;
  await rejects(() => f.service.confirmBpub(preview.id));
  const saved = await f.repo.loadState();
  const pair = saved.intents.map((i) => i.rawTx);
  // Reproduce the old client's false-positive status observations. No mock node accepted the pair.
  for (const intent of saved.intents) {
    intent.phase = "seen";
    intent.broadcastStartedAt = intent.createdAt;
    delete intent.lastBroadcastAt;
    delete intent.lastError;
    intent.lastObservation = {
      checkedAt: intent.createdAt,
      backendOk: true,
      tx: { present: true, confirmed: false, confirmations: 0 },
    };
  }
  await f.repo.saveState(saved);
  f.blake.posts = [];
  f.blake.failPost = 0;
  await f.service.lock();
  const restarted = new WalletService(f.repo, (chain) => chain === "blake" ? f.blake : f.btc);
  await restarted.initialize();
  await restarted.unlock(PASSWORD);
  await restarted.sync();
  assert(f.blake.posts.length === 0, "Sync must not broadcast");
  assert(restarted.snapshot().publications[0].fundingPhase === "recoverable");
  await restarted.resumeBpub(preview.id);
  assert(
    JSON.stringify(f.blake.posts) === JSON.stringify(pair),
    "Resume must send the exact saved pair",
  );
  assert((await f.repo.loadState()).publications.length === 1);
  assert(restarted.snapshot().publications[0].dataUnspent === 0);
  assert(f.btc.posts.length === 0);
  await restarted.resumeBpub(preview.id);
  assert(f.blake.posts.length === 2, "Do not resend an accepted pair");
  await restarted.lock();
});

Deno.test("BPUB custom ownership amounts survive signing, restart and observation refresh", async () => {
  for (const ownerValue of [330, 10000, 25000]) {
    const f = await fixture();
    const standard = await f.service.previewBpub(f.request);
    assert(standard.ownerValue === 330);
    const preview = await f.service.previewBpub({ ...f.request, ownerValue });
    assert(preview.ownerValue === ownerValue);
    assert(preview.fundingChange === standard.fundingChange + 330 - ownerValue);
    f.blake.failPost = 2;
    await rejects(() => f.service.confirmBpub(preview.id));
    const saved = await f.repo.loadState();
    parseWalletState(saved);
    const funding = RawTx.decode(fromHex(saved.intents[0].rawTx));
    assert(Number(funding.outputs.at(-2)!.amount) === ownerValue);
    const corrupted = structuredClone(saved);
    corrupted.publications[0].preview.ownerValue++;
    let rejected = false;
    try {
      parseWalletState(corrupted);
    } catch {
      rejected = true;
    }
    assert(rejected, "Ownership review must match the saved transaction");
    const restarted = new WalletService(f.repo, (chain) => chain === "blake" ? f.blake : f.btc);
    await restarted.initialize();
    await restarted.unlock(PASSWORD);
    await restarted.resumeBpub(preview.id);
    assert(restarted.snapshot().publications[0].ownerUnspent === ownerValue);
    await restarted.sync();
    assert(restarted.snapshot().publications[0].ownerUnspent === ownerValue);
    assert(f.btc.posts.length === 0);
    await restarted.lock();
    await f.service.lock();
  }
});

Deno.test("completed BPUB publications stop polling outspends and resume after a reorg", async () => {
  const f = await fixture();
  const preview = await f.service.previewBpub(f.request);
  const published = await f.service.confirmBpub(preview.id);
  const publication = published.publications[0];
  f.blake.statuses.set(publication.fundingTxid, { confirmed: true, block_height: 961649 });
  f.blake.statuses.set(publication.revealTxid, { confirmed: true, block_height: 961650 });
  const callsBeforeCompletion = f.blake.outspendCalls;

  let snapshot = await f.service.sync();
  assert(snapshot.publications[0].fundingPhase === "confirmed");
  assert(snapshot.publications[0].revealPhase === "confirmed");
  assert(f.blake.outspendCalls === callsBeforeCompletion, "Completed publication was polled");
  assert(snapshot.publications[0].dataUnspent === null);
  assert(snapshot.publications[0].ownerUnspent === null);
  assert(snapshot.publications[0].checkedAt === undefined);

  f.blake.outspendFailure = true;
  snapshot = await f.service.sync();
  assert(f.blake.outspendCalls === callsBeforeCompletion, "Completed publication was polled again");
  assert(!snapshot.publications[0].lastError);

  f.blake.outspendFailure = false;
  f.blake.statuses.set(publication.revealTxid, { confirmed: false });
  snapshot = await f.service.sync();
  assert(snapshot.publications[0].revealPhase === "seen");
  assert(f.blake.outspendCalls === callsBeforeCompletion + 1, "Reorg did not resume observation");
  assert(snapshot.publications[0].dataUnspent === 0);
  assert(snapshot.publications[0].ownerUnspent === 330);
});

Deno.test("BPUB reveal timeout only retries the exact reveal; partial observations are unknown", async () => {
  const f = await fixture();
  f.blake.failPost = 2;
  const preview = await f.service.previewBpub(f.request);
  await rejects(() => f.service.confirmBpub(preview.id));
  const pendingReveal = f.service.snapshot().intents.find((i) => i.kind === "blake-bpub-reveal");
  assert(pendingReveal?.phase === "broadcast-unknown" && !pendingReveal.canRebroadcast);
  await f.service.resumeBpub(preview.id);
  assert(f.blake.posts.length === 3 && f.blake.posts[1] === f.blake.posts[2]);
  f.blake.outspendFailure = true;
  await f.service.sync();
  assert(f.service.snapshot().publications[0].dataUnspent === null);
  assert(f.service.snapshot().publications[0].lastError?.includes("429"));
});
Deno.test("BPUB disk failures prevent unsigned progress and child exposure", async () => {
  const f = await fixture();
  let preview = await f.service.previewBpub(f.request);
  f.repo.failPrepared = true;
  await rejects(() => f.service.confirmBpub(preview.id));
  assert(f.blake.posts.length === 0 && (await f.repo.loadState()).publications.length === 0);
  f.repo.failPrepared = false;
  preview = await f.service.previewBpub(f.request);
  f.repo.failRevealMarker = true;
  await rejects(() => f.service.confirmBpub(preview.id));
  assert(f.blake.posts.length === 1);
  const preparedReveal = f.service.snapshot().intents.find((i) => i.kind === "blake-bpub-reveal");
  assert(preparedReveal?.phase === "prepared" && !preparedReveal.canRebroadcast);
  f.repo.failRevealMarker = false;
  await f.service.resumeBpub(preview.id);
  assert(f.blake.posts.length === 2);
});
Deno.test("BPUB refuses foreign backends and cancels previews on lock", async () => {
  const f = await fixture();
  let preview = await f.service.previewBpub(f.request);
  await f.service.lock();
  await f.service.unlock(PASSWORD);
  await rejects(() => f.service.confirmBpub(preview.id));
  preview = await f.service.previewBpub(f.request);
  f.blake.checkpointFailure = true;
  await rejects(() => f.service.confirmBpub(preview.id));
  assert(f.blake.posts.length === 0 && f.btc.posts.length === 0);
});
Deno.test("BPUB state migration preserves schema-1 wallets and rejects damaged publication records", async () => {
  const legacy = { ...emptyPublicState(), schema: 1 } as Record<string, unknown>;
  delete legacy.publications;
  delete legacy.nextPublicationIndex;
  const migrated = parseWalletState(legacy);
  assert(migrated.schema === 2 && migrated.publications.length === 0);
  const f = await fixture();
  const preview = await f.service.previewBpub(f.request);
  await f.service.confirmBpub(preview.id);
  const saved = await f.repo.loadState();
  for (
    const mutate of [
      (s: WalletPublicState) => {
        s.publications[0].preview.fundingChange++;
      },
      (s: WalletPublicState) => {
        s.publications[0].witnessScripts[0] = "00";
      },
      (s: WalletPublicState) => {
        s.publications = [];
      },
      (s: WalletPublicState) => {
        s.nextPublicationIndex = 0;
      },
    ]
  ) {
    const copy = structuredClone(saved);
    mutate(copy);
    await rejects(() => Promise.resolve(parseWalletState(copy)));
  }
});
