import { Transaction } from "@scure/btc-signer";
import { fromHex } from "./bytes.ts";
import { EsploraClient, EsploraError, type FetchLike } from "./esplora.ts";

Deno.test("Esplora validates BPUB outspends and uses one GET for all outputs", async () => {
  const id = "11".repeat(32);
  let requests = 0;
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    requests++;
    if (String(input) !== `https://example.invalid/api/tx/${id}/outspends`) {
      throw new Error("Wrong outspend endpoint");
    }
    return Promise.resolve(Response.json([
      { spent: false },
      { spent: false, txid: null, vin: null, status: null },
      { spent: true, txid: id },
    ]));
  });
  const outputs = await client.transactionOutspends(id);
  if (
    requests !== 1 || outputs.length !== 3 || outputs[0].spent || outputs[1].spent ||
    outputs[1].txid !== null || !outputs[2].spent
  ) {
    throw new Error("Unexpected outspend observations");
  }
  for (
    const body of [
      {},
      [null],
      [{ spent: 1 }],
      [{ spent: false, txid: id }],
      [{ spent: true }],
      [{ spent: true, txid: null }],
      [{ spent: true, txid: 123 }],
    ]
  ) {
    const malformed = new EsploraClient(
      "https://example.invalid/api",
      () => Promise.resolve(Response.json(body)),
    );
    let rejected = false;
    try {
      await malformed.transactionOutspends(id);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Malformed outspends accepted");
  }
});

Deno.test("Esplora requires HTTPS except on explicit loopback hosts", () => {
  for (
    const url of [
      "http://localhost:3000/api",
      "http://127.0.0.1:3000/api",
      "http://[::1]:3000/api",
      "https://example.com/api",
    ]
  ) {
    new EsploraClient(url);
  }
  for (const url of ["http://example.com/api", "http://192.168.1.10/api"]) {
    let message = "";
    try {
      new EsploraClient(url);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes("only on localhost")) {
      throw new Error(`Plaintext remote backend was accepted: ${url}`);
    }
  }
});

Deno.test("Esplora appends endpoints to base paths", async () => {
  let requested = "";
  const client = new EsploraClient("https://example.invalid/api/", (input) => {
    requested = String(input);
    return Promise.resolve(new Response("961650"));
  });
  await client.tipHeight();
  const url = new URL(requested);
  if (url.pathname !== "/api/blocks/tip/height" || url.search !== "") {
    throw new Error(`Custom backend path was not preserved correctly: ${requested}`);
  }
});

Deno.test("Esplora rejects credentials, query parameters, and fragments", () => {
  for (
    const url of [
      "https://user:password@example.invalid/api",
      "https://example.invalid/api?token=secret",
      "https://example.invalid/api#unexpected",
    ]
  ) {
    let rejected = false;
    try {
      new EsploraClient(url);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`Public backend URL accepted private components: ${url}`);
  }
});

Deno.test("Esplora never retries a rate-limit response", async () => {
  let requests = 0;
  const fetcher: FetchLike = () => {
    requests++;
    return Promise.resolve(
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    );
  };
  const client = new EsploraClient("https://example.invalid/api", fetcher);

  let error: unknown;
  try {
    await client.addressUtxos("bc1ptest");
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof EsploraError) || error.status !== 429) {
    throw new Error("Expected an Esplora 429 error");
  }
  if (!error.message.includes("retry after 60")) {
    throw new Error("Retry-After was not included in the error");
  }
  if (requests !== 1) throw new Error(`Expected one request after HTTP 429, got ${requests}`);
});

Deno.test("Esplora does not retry a server failure automatically", async () => {
  let requests = 0;
  const fetcher: FetchLike = () => {
    requests++;
    return Promise.resolve(new Response("temporary failure", { status: 500 }));
  };
  const client = new EsploraClient("https://example.invalid/api", fetcher);

  let error: unknown;
  try {
    await client.addressUtxos("bc1ptest");
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof EsploraError) || error.status !== 500) {
    throw new Error("Expected an Esplora 500 error");
  }
  if (requests !== 1) throw new Error(`Expected one request after HTTP 500, got ${requests}`);
});

Deno.test("Esplora validates a fee estimate with one backend request", async () => {
  let requests = 0;
  const client = new EsploraClient("https://example.invalid/api", () => {
    requests++;
    return Promise.resolve(Response.json({
      fastestFee: 8.1,
      halfHourFee: 6,
      hourFee: 4,
      economyFee: 2,
      minimumFee: 1,
    }));
  });
  const fees = await client.recommendedFees();
  if (fees.fastestFee !== 8.1 || requests !== 1) {
    throw new Error(`Unexpected fee estimate or request count: ${fees.fastestFee}, ${requests}`);
  }

  const malformed = new EsploraClient(
    "https://example.invalid/api",
    () => Promise.resolve(Response.json({ fastestFee: "8.1" })),
  );
  let message = "";
  try {
    await malformed.recommendedFees();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("malformed fee estimate")) {
    throw new Error(`Malformed fee estimate was accepted: ${message}`);
  }
});

Deno.test("Esplora rejects malformed UTXO arrays and entries", async () => {
  for (const value of [{}, [null], [{ txid: "not-a-txid", vout: 0 }]]) {
    const client = new EsploraClient(
      "https://example.invalid/api",
      () => Promise.resolve(Response.json(value)),
    );
    let message = "";
    try {
      await client.addressUtxos("bc1ptest");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes("malformed UTXO list")) {
      throw new Error(`Malformed UTXO response was accepted: ${JSON.stringify(value)}`);
    }
  }
});

Deno.test("Esplora ignores valid zero-valued UTXOs without hiding positive coins", async () => {
  const positiveTxid = "44".repeat(32);
  const client = new EsploraClient(
    "https://example.invalid/api",
    () =>
      Promise.resolve(Response.json([
        { txid: "33".repeat(32), vout: 0, value: 0, status: { confirmed: false } },
        { txid: positiveTxid, vout: 1, value: 2_500, status: { confirmed: false } },
      ])),
  );

  const utxos = await client.addressUtxos("bc1ptest");
  if (utxos.length !== 1 || utxos[0].txid !== positiveTxid || utxos[0].value !== 2_500) {
    throw new Error("Zero-valued output handling discarded or retained the wrong coin");
  }
});

Deno.test("Esplora transaction status treats one 404 as absence", async () => {
  let requests = 0;
  const fetcher: FetchLike = () => {
    requests++;
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const client = new EsploraClient("https://example.invalid/api", fetcher);
  const status = await client.transactionStatus("11".repeat(32));

  if (status !== null) throw new Error("A missing transaction should return null");
  if (requests !== 1) throw new Error(`Expected one status request, got ${requests}`);
});

Deno.test("Esplora validates every transaction-status field", async () => {
  for (
    const value of [
      { confirmed: true },
      { confirmed: false, block_height: -1 },
      { confirmed: false, block_hash: 123 },
      { confirmed: false, block_hash: "zz".repeat(32) },
      { confirmed: false, block_time: 1.5 },
    ]
  ) {
    const client = new EsploraClient(
      "https://example.invalid/api",
      () => Promise.resolve(Response.json(value)),
    );
    let message = "";
    try {
      await client.transactionStatus("12".repeat(32));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes("malformed transaction status")) {
      throw new Error(`Malformed transaction status was accepted: ${JSON.stringify(value)}`);
    }
  }

  const valid = {
    confirmed: true,
    block_height: 961_649,
    block_hash: "13".repeat(32),
    block_time: 1_700_000_000,
  };
  const client = new EsploraClient(
    "https://example.invalid/api",
    () => Promise.resolve(Response.json(valid)),
  );
  if (JSON.stringify(await client.transactionStatus("14".repeat(32))) !== JSON.stringify(valid)) {
    throw new Error("A complete transaction status was rejected or altered");
  }
});

Deno.test("Esplora does not mistake an unknown transaction for an unconfirmed one", async () => {
  const txid = "15".repeat(32);
  const requests: string[] = [];
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    return Promise.resolve(
      path.endsWith("/status")
        ? Response.json({ confirmed: false })
        : new Response("Transaction not found", { status: 404 }),
    );
  });
  if (await client.transactionStatus(txid) !== null) {
    throw new Error("Unknown transaction was marked present");
  }
  if (
    requests.length !== 2 || requests[0] !== `/api/tx/${txid}/status` ||
    requests[1] !== `/api/tx/${txid}/hex`
  ) {
    throw new Error("An ambiguous status must use the compact existence probe");
  }
});

Deno.test("Esplora polls confirmed status without downloading the transaction", async () => {
  const txid = "16".repeat(32);
  const paths: string[] = [];
  const status = { confirmed: true, block_height: 961_649 };
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    paths.push(new URL(String(input)).pathname);
    return Promise.resolve(Response.json(status));
  });
  if (JSON.stringify(await client.transactionStatus(txid)) !== JSON.stringify(status)) {
    throw new Error("Confirmed transaction status was not preserved");
  }
  if (paths.length !== 1 || paths[0] !== `/api/tx/${txid}/status`) {
    throw new Error("Confirmed status polling downloaded transaction data");
  }
});

Deno.test("Esplora accepts an existing unconfirmed transaction using its compact hex", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const txid = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  }).id;
  const paths: string[] = [];
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Promise.resolve(
      path.endsWith("/status") ? Response.json({ confirmed: false }) : new Response(rawTx),
    );
  });
  const status = await client.transactionStatus(txid);
  if (!status || status.confirmed) throw new Error("Existing unconfirmed transaction was rejected");
  if (
    paths.length !== 2 || paths[0] !== `/api/tx/${txid}/status` ||
    paths[1] !== `/api/tx/${txid}/hex`
  ) {
    throw new Error("Unconfirmed existence check used the wrong endpoints");
  }
});

Deno.test("Esplora detects a saved intent in the mempool without downloading it", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  const requests: Array<{ path: string; method: string; body?: string }> = [];
  const client = new EsploraClient("https://example.invalid/api", (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() });
    if (path.endsWith("/status")) return Promise.resolve(Response.json({ confirmed: false }));
    if (path.endsWith("/txs/test")) {
      return Promise.resolve(Response.json([{
        txid: transaction.id,
        wtxid: transaction.id,
        allowed: false,
        "reject-reason": "txn-already-in-mempool",
      }]));
    }
    throw new Error("Unexpected endpoint");
  });

  const status = await client.transactionStatus(transaction.id, rawTx);
  if (!status || status.confirmed) throw new Error("Mempool intent was not observed");
  if (
    requests.length !== 2 || requests[0].path !== `/api/tx/${transaction.id}/status` ||
    requests[1].path !== "/api/txs/test" || requests[1].method !== "POST" ||
    requests[1].body !== JSON.stringify([rawTx])
  ) {
    throw new Error("Saved intent status used the wrong mempool probe");
  }
});

Deno.test("Esplora treats an acceptable saved intent as absent", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    const path = new URL(String(input)).pathname;
    return Promise.resolve(
      path.endsWith("/status") ? Response.json({ confirmed: false }) : Response.json([{
        txid: transaction.id,
        wtxid: transaction.id,
        allowed: true,
        "reject-reason": null,
      }]),
    );
  });
  if (await client.transactionStatus(transaction.id, rawTx) !== null) {
    throw new Error("An absent acceptable intent was marked present");
  }
});

Deno.test("Esplora verifies ambiguous mempool rejection through exact transaction lookup", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  const paths: string[] = [];
  const client = new EsploraClient("https://example.invalid/api", (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/status")) return Promise.resolve(Response.json({ confirmed: false }));
    if (path.endsWith("/txs/test")) {
      return Promise.resolve(Response.json([{
        txid: transaction.id,
        wtxid: transaction.id,
        allowed: false,
        "reject-reason": "missing-inputs",
      }]));
    }
    return Promise.resolve(new Response(rawTx));
  });

  const status = await client.transactionStatus(transaction.id, rawTx);
  if (!status || status.confirmed) {
    throw new Error("A transaction mined during the status probe was treated as absent");
  }
  if (
    paths.length !== 3 || paths[0] !== `/api/tx/${transaction.id}/status` ||
    paths[1] !== "/api/txs/test" || paths[2] !== `/api/tx/${transaction.id}/hex`
  ) {
    throw new Error("Ambiguous rejection did not use the exact-transaction fallback");
  }
});

Deno.test("Esplora retains exact-hex compatibility when mempool testing is unavailable", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  for (const unsupportedStatus of [404, 405, 501]) {
    const paths: string[] = [];
    const client = new EsploraClient("https://example.invalid/api", (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/status")) return Promise.resolve(Response.json({ confirmed: false }));
      if (path.endsWith("/txs/test")) {
        return Promise.resolve(new Response("Unsupported endpoint", { status: unsupportedStatus }));
      }
      return Promise.resolve(new Response(rawTx));
    });
    const status = await client.transactionStatus(transaction.id, rawTx);
    if (!status || status.confirmed) throw new Error("Fallback lost the unconfirmed transaction");
    if (
      paths.length !== 3 || paths[0] !== `/api/tx/${transaction.id}/status` ||
      paths[1] !== "/api/txs/test" || paths[2] !== `/api/tx/${transaction.id}/hex`
    ) {
      throw new Error(
        `Unsupported mempool-test status ${unsupportedStatus} did not use the safe fallback`,
      );
    }
  }
});

Deno.test("Esplora does not hide genuine mempool-test failures behind the fallback", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  for (const failureStatus of [400, 429, 500]) {
    let requests = 0;
    const client = new EsploraClient("https://example.invalid/api", (input) => {
      requests++;
      return Promise.resolve(
        new URL(String(input)).pathname.endsWith("/status")
          ? Response.json({ confirmed: false })
          : new Response("Backend failure", { status: failureStatus }),
      );
    });
    let error: unknown;
    try {
      await client.transactionStatus(transaction.id, rawTx);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof EsploraError) || error.status !== failureStatus || requests !== 2) {
      throw new Error(`Mempool-test failure ${failureStatus} was hidden behind the hex fallback`);
    }
  }
});

Deno.test("Esplora requires mempool acceptance results for the requested intent", async () => {
  const rawTx = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  const transaction = Transaction.fromRaw(fromHex(rawTx), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  for (
    const result of [
      [],
      [{
        txid: "19".repeat(32),
        wtxid: "19".repeat(32),
        allowed: false,
        "reject-reason": "txn-already-in-mempool",
      }],
      [{ txid: transaction.id, wtxid: transaction.id, allowed: false }],
    ]
  ) {
    const client = new EsploraClient("https://example.invalid/api", (input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/status")
          ? Response.json({ confirmed: false })
          : Response.json(result),
      ));
    let error: unknown;
    try {
      await client.transactionStatus(transaction.id, rawTx);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof EsploraError)) {
      throw new Error("Malformed or mismatched mempool result was accepted");
    }
  }
});

Deno.test("Esplora rejects malformed or mismatched unconfirmed transaction hex", async () => {
  const requested = "17".repeat(32);
  const otherRaw = `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`;
  for (const rawTx of ["01000000", otherRaw]) {
    const client = new EsploraClient("https://example.invalid/api", (input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/status")
          ? Response.json({ confirmed: false })
          : new Response(rawTx),
      ));
    let error: unknown;
    try {
      await client.transactionStatus(requested);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof EsploraError)) {
      throw new Error("Invalid existence proof was accepted");
    }
  }
});

Deno.test("Esplora transaction lookup preserves backend failures, not absence", async () => {
  for (const status of [429, 500]) {
    let calls = 0;
    const client = new EsploraClient("https://example.invalid/api", () => {
      calls++;
      return Promise.resolve(new Response("unavailable", { status }));
    });
    let error: unknown;
    try {
      await client.transactionStatus("18".repeat(32));
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof EsploraError) || error.status !== status || calls !== 1) {
      throw new Error("Backend failure was hidden or retried");
    }
  }
});

Deno.test("Esplora validates transaction hex without retrying", async () => {
  let requests = 0;
  const fetcher: FetchLike = () => {
    requests++;
    return Promise.resolve(new Response("not transaction hex"));
  };
  const client = new EsploraClient("https://example.invalid/api", fetcher);

  let error: unknown;
  try {
    await client.transactionHex("22".repeat(32));
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof EsploraError) || !error.message.includes("malformed")) {
    throw new Error("Malformed transaction hex should be rejected");
  }
  if (requests !== 1) throw new Error(`Expected one transaction request, got ${requests}`);
});

Deno.test("Esplora rejects malformed address statistics", async () => {
  const client = new EsploraClient(
    "https://example.invalid/api",
    () =>
      Promise.resolve(Response.json({
        address: "bc1ptest",
        chain_stats: {},
        mempool_stats: { tx_count: "0" },
      })),
  );
  let message = "";
  try {
    await client.address("bc1ptest");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("malformed address statistics")) {
    throw new Error(`Malformed statistics were not rejected: ${message}`);
  }
});

Deno.test("Esplora rejects statistics for a different address", async () => {
  const stats = {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  };
  const client = new EsploraClient(
    "https://example.invalid/api",
    () =>
      Promise.resolve(Response.json({
        address: "bc1pwrong",
        chain_stats: stats,
        mempool_stats: stats,
      })),
  );
  let message = "";
  try {
    await client.address("bc1pexpected");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("different address")) {
    throw new Error(`Mismatched address statistics were accepted: ${message}`);
  }
});

Deno.test("Esplora stops streaming when the response cap is exceeded", async () => {
  let chunks = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new EsploraClient(
    "https://example.invalid/api",
    () => Promise.resolve(new Response(stream)),
  );
  let message = "";
  try {
    await client.tipHeight();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await Promise.resolve();
  if (!message.includes("response is too large")) {
    throw new Error(`Oversized streamed response was accepted: ${message}`);
  }
  // Response streams may keep one pull queued ahead of the reader.
  if (!cancelled || chunks > 66) {
    throw new Error(`Stream was not cancelled at the response cap (${chunks} chunks)`);
  }
});

Deno.test("Esplora timeout includes a stalled successful response body", async () => {
  const fetcher: FetchLike = (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const client = new EsploraClient("https://example.invalid/api", fetcher, 20);
  const started = Date.now();
  let message = "";
  try {
    await client.tipHeight();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("timed out") && !message.includes("Abort")) {
    throw new Error(`Stalled response did not time out: ${message}`);
  }
  if (Date.now() - started > 1_000) throw new Error("Body timeout took too long");
});
