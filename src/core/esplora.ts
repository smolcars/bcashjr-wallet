import { Transaction } from "@scure/btc-signer";
import { fromHex } from "./bytes.ts";

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: EsploraTxStatus;
}

export interface EsploraOutspend {
  spent: boolean;
  txid?: string | null;
}

export interface MempoolAcceptance {
  txid: string;
  wtxid: string;
  allowed: boolean;
  rejectReason: string | null;
}

export interface EsploraAddressStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface EsploraAddress {
  address: string;
  chain_stats: EsploraAddressStats;
  mempool_stats: EsploraAddressStats;
}

export interface RecommendedFees {
  fastestFee: number;
  halfHourFee?: number;
  hourFee?: number;
  economyFee?: number;
  minimumFee?: number;
}

export class EsploraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "EsploraError";
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ADDRESS_STAT_FIELDS = [
  "funded_txo_count",
  "funded_txo_sum",
  "spent_txo_count",
  "spent_txo_sum",
  "tx_count",
] as const;

function validAddressStats(value: unknown): value is EsploraAddressStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as Record<string, unknown>;
  return ADDRESS_STAT_FIELDS.every((field) =>
    Number.isSafeInteger(stats[field]) && (stats[field] as number) >= 0
  );
}

function validTxStatus(value: unknown): value is EsploraTxStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return typeof status.confirmed === "boolean" &&
    (!status.confirmed ||
      (Number.isSafeInteger(status.block_height) && (status.block_height as number) >= 0)) &&
    (status.block_height === undefined ||
      (Number.isSafeInteger(status.block_height) && (status.block_height as number) >= 0)) &&
    (status.block_hash === undefined ||
      (typeof status.block_hash === "string" && /^[0-9a-f]{64}$/u.test(status.block_hash))) &&
    (status.block_time === undefined ||
      (Number.isSafeInteger(status.block_time) && (status.block_time as number) >= 0));
}

function validUtxo(value: unknown): value is EsploraUtxo {
  if (!value || typeof value !== "object") return false;
  const utxo = value as Record<string, unknown>;
  if (
    typeof utxo.txid !== "string" || !/^[0-9a-f]{64}$/u.test(utxo.txid) ||
    !Number.isSafeInteger(utxo.vout) || (utxo.vout as number) < 0 ||
    (utxo.vout as number) > 0xffff_ffff ||
    !Number.isSafeInteger(utxo.value) || (utxo.value as number) < 0 ||
    !utxo.status || typeof utxo.status !== "object"
  ) return false;
  return validTxStatus(utxo.status);
}

function isExplicitLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeEsploraUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Backend URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Backend URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isExplicitLoopback(url.hostname)) {
    throw new Error("Plaintext HTTP backend URLs are allowed only on localhost");
  }
  if (url.username || url.password || url.search) {
    throw new Error("Backend URL must not contain credentials or query parameters");
  }
  if (url.hash) throw new Error("Backend URL must not contain a fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

function esploraEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
  url.hash = "";
  return url.toString();
}

async function readLimitedBody(
  response: Response,
  timeout: Promise<never>,
  controller: AbortController,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (!value?.length) continue;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel("Esplora response is too large").catch(() => undefined);
        controller.abort();
        throw new EsploraError("Esplora response is too large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class EsploraClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly fetcher: FetchLike = fetch,
    readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = normalizeEsploraUrl(baseUrl);
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let response: Response | undefined;
    let rejectTimeout: ((reason: Error) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => rejectTimeout = reject);
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new Error(`request timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    try {
      response = await Promise.race([
        this.fetcher(esploraEndpoint(this.baseUrl, path), {
          ...init,
          redirect: "error",
          signal: controller.signal,
          headers: { "Accept": "application/json, text/plain", ...init?.headers },
        }),
        timeout,
      ]);
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        controller.abort();
        void response.body?.cancel("Esplora response is too large").catch(() => undefined);
        throw new EsploraError("Esplora response is too large", response.status);
      }
      const bytes = await readLimitedBody(response, timeout, controller);
      const buffered = new Response(
        bytes.length === 0 || [204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
      if (buffered.ok || buffered.status === 404) return buffered;
      const body = await buffered.text();
      if (buffered.status === 429) {
        const retryAfter = buffered.headers.get("Retry-After");
        throw new EsploraError(
          `Esplora rate limit reached${retryAfter ? `; retry after ${retryAfter}` : ""}`,
          buffered.status,
          body,
        );
      }
      throw new EsploraError(
        `Esplora request failed (${buffered.status})`,
        buffered.status,
        body,
      );
    } catch (error) {
      if (error instanceof EsploraError) throw error;
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new EsploraError(`Esplora request failed${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async #json<T>(path: string): Promise<T> {
    const response = await this.#request(path);
    if (response.status === 404) throw new EsploraError("Resource not found", 404);
    return await response.json() as T;
  }

  async tipHeight(): Promise<number> {
    const heightResponse = await this.#request("/blocks/tip/height");
    if (!heightResponse.ok) throw new EsploraError("Unable to read chain tip");
    const height = Number(await heightResponse.text());
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new EsploraError("Backend returned a malformed chain height");
    }
    return height;
  }

  async blockHash(height: number): Promise<string> {
    const response = await this.#request(`/block-height/${height}`);
    if (!response.ok) throw new EsploraError("Block height is unavailable", response.status);
    return (await response.text()).trim();
  }

  async address(address: string): Promise<EsploraAddress> {
    const info = await this.#json<unknown>(`/address/${encodeURIComponent(address)}`);
    if (
      !info || typeof info !== "object" ||
      typeof (info as Partial<EsploraAddress>).address !== "string" ||
      !validAddressStats((info as Partial<EsploraAddress>).chain_stats) ||
      !validAddressStats((info as Partial<EsploraAddress>).mempool_stats)
    ) {
      throw new EsploraError("Backend returned malformed address statistics");
    }
    if ((info as EsploraAddress).address.toLowerCase() !== address.toLowerCase()) {
      throw new EsploraError("Backend returned statistics for a different address");
    }
    return info as EsploraAddress;
  }

  async addressUtxos(address: string): Promise<EsploraUtxo[]> {
    const value = await this.#json<unknown>(`/address/${encodeURIComponent(address)}/utxo`);
    if (!Array.isArray(value) || !value.every(validUtxo)) {
      throw new EsploraError("Backend returned a malformed UTXO list");
    }
    // Zero-valued outputs are consensus-valid, but there is nothing useful for this sweep wallet
    // to select. Ignore them without rejecting the address's positive-valued outputs.
    return value.filter((utxo) => utxo.value > 0);
  }

  async transactionStatus(txid: string, rawTx?: string): Promise<EsploraTxStatus | null> {
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error("Invalid transaction id");
    // Some backends return { confirmed: false } from /status even for unknown IDs.
    // Confirmed results are unambiguous. For locally signed intents, test the saved transaction
    // against the node's mempool without broadcasting it. Other txid-only callers retain the
    // exact-hex fallback because testmempoolaccept requires the original transaction.
    const response = await this.#request(`/tx/${txid}/status`);
    if (response.status === 404) return null;
    const status = await response.json() as unknown;
    if (!validTxStatus(status)) {
      throw new EsploraError("Backend returned a malformed transaction status");
    }
    if (status.confirmed) return status;
    if (rawTx !== undefined) {
      try {
        const acceptance = await this.testMempoolAcceptance(rawTx);
        if (acceptance.txid !== txid) {
          throw new EsploraError("Backend tested a different transaction");
        }
        if (acceptance.allowed) return null;
        if (
          acceptance.rejectReason === "txn-already-in-mempool" ||
          acceptance.rejectReason === "txn-same-nonwitness-data-in-mempool"
        ) return status;
        // Any other rejection is ambiguous. In particular, a transaction mined after the
        // unconfirmed status response can now fail with missing inputs. Fall through to the
        // exact transaction lookup instead of treating it as absent.
      } catch (error) {
        // /txs/test is a mempool/electrs extension rather than baseline Esplora. Preserve
        // compatibility with custom backends that do not implement it, without hiding an
        // overloaded or failing endpoint.
        if (
          !(error instanceof EsploraError) ||
          ![404, 405, 501].includes(error.status ?? 0)
        ) throw error;
      }
    }
    const existence = await this.#request(`/tx/${txid}/hex`);
    if (existence.status === 404) return null;
    const observedRawTx = (await existence.text()).trim().toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/u.test(observedRawTx) || observedRawTx.length > 2_000_000) {
      throw new EsploraError("Backend returned malformed transaction hex");
    }
    let observedTxid: string;
    try {
      observedTxid = Transaction.fromRaw(fromHex(observedRawTx), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      }).id;
    } catch {
      throw new EsploraError("Backend returned malformed transaction hex");
    }
    if (observedTxid !== txid) {
      throw new EsploraError("Backend returned transaction hex for a different transaction");
    }
    return status;
  }

  async testMempoolAcceptance(rawTx: string): Promise<MempoolAcceptance> {
    const normalized = rawTx.trim().toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/u.test(normalized) || normalized.length > 2_000_000) {
      throw new Error("Invalid transaction hex");
    }
    const response = await this.#request("/txs/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([normalized]),
    });
    if (response.status === 404) {
      throw new EsploraError("Backend does not support mempool acceptance testing", 404);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new EsploraError("Backend returned malformed mempool acceptance results");
    }
    if (!Array.isArray(value) || value.length !== 1) {
      throw new EsploraError("Backend returned malformed mempool acceptance results");
    }
    const result = value[0] as Record<string, unknown> | null;
    const rejectReason = result?.["reject-reason"];
    if (
      !result || typeof result !== "object" ||
      typeof result.txid !== "string" || !/^[0-9a-f]{64}$/u.test(result.txid) ||
      typeof result.wtxid !== "string" || !/^[0-9a-f]{64}$/u.test(result.wtxid) ||
      typeof result.allowed !== "boolean" ||
      (rejectReason !== undefined && rejectReason !== null &&
        typeof rejectReason !== "string") ||
      (result.allowed && rejectReason !== undefined && rejectReason !== null) ||
      (!result.allowed && typeof rejectReason !== "string")
    ) {
      throw new EsploraError("Backend returned malformed mempool acceptance results");
    }
    return {
      txid: result.txid,
      wtxid: result.wtxid,
      allowed: result.allowed,
      rejectReason: typeof rejectReason === "string" ? rejectReason : null,
    };
  }

  async transactionOutspends(txid: string): Promise<EsploraOutspend[]> {
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error("Invalid transaction id");
    const value = await this.#json<unknown>(`/tx/${txid}/outspends`);
    if (
      !Array.isArray(value) || value.some((item) =>
        !item || typeof item !== "object" ||
        typeof item.spent !== "boolean" ||
        (item.spent && (typeof item.txid !== "string" || !/^[0-9a-f]{64}$/u.test(item.txid))) ||
        (!item.spent && item.txid !== undefined && item.txid !== null)
      )
    ) throw new Error("Invalid transaction outspends response");
    return value;
  }

  async transactionHex(txid: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error("Invalid transaction id");
    const response = await this.#request(`/tx/${txid}/hex`);
    if (response.status === 404) throw new EsploraError("Transaction not found", 404);
    const rawTx = (await response.text()).trim().toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/u.test(rawTx) || rawTx.length > 2_000_000) {
      throw new EsploraError("Backend returned malformed transaction hex");
    }
    return rawTx;
  }

  async recommendedFees(): Promise<RecommendedFees> {
    const value = await this.#json<unknown>("/v1/fees/recommended");
    if (!value || typeof value !== "object") {
      throw new EsploraError("Backend returned a malformed fee estimate");
    }
    const fees = value as Record<string, unknown>;
    const optionalFields = ["halfHourFee", "hourFee", "economyFee", "minimumFee"];
    if (
      !Number.isFinite(fees.fastestFee) || (fees.fastestFee as number) <= 0 ||
      optionalFields.some((field) =>
        fees[field] !== undefined &&
        (!Number.isFinite(fees[field]) || (fees[field] as number) < 0)
      )
    ) {
      throw new EsploraError("Backend returned a malformed fee estimate");
    }
    return value as RecommendedFees;
  }

  async broadcast(rawTx: string): Promise<string> {
    const response = await this.#request("/tx", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTx,
    });
    if (!response.ok) throw new EsploraError("Transaction broadcast failed", response.status);
    return (await response.text()).trim();
  }
}
