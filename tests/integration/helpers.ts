import { Address, NETWORK } from "@scure/btc-signer";
import { EsploraClient } from "../../src/core/esplora.ts";

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function regtestAddress(address: string): string {
  return Address({ ...NETWORK, bech32: "bcrt", pubKeyHash: 111, scriptHash: 196, wif: 239 })
    .encode(Address(NETWORK).decode(address));
}
// Only address presentation differs. Scripts, transaction bytes, HTTP parsing, signing,
// persistence and workflow logic are the production implementations.
export class RegtestClient extends EsploraClient {
  override async address(address: string) {
    return { ...await super.address(regtestAddress(address)), address };
  }
  override addressUtxos(address: string) {
    return super.addressUtxos(regtestAddress(address));
  }
}
export class Rpc {
  constructor(readonly url: string) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet = ""): Promise<T> {
    const response = await fetch(this.url + (wallet ? `/wallet/${wallet}` : ""), {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa("regtest:regtest")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    return body.result as T;
  }
}
export async function eventually<T>(
  label: string,
  fn: () => Promise<T>,
  ready: (v: T) => boolean,
  timeout = 90000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (ready(value)) return value;
      last = value;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
export function picture(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let seed = 1;
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data[i] = seed & 255;
  }
  data.set(new TextEncoder().encode("GIF89a"));
  return data;
}
