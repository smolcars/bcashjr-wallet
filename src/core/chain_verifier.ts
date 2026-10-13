import type { EsploraClient } from "./esplora.ts";
import type { ChainId, ChainTip } from "./types.ts";

export type ChainCheckpoints = Record<ChainId, { height: number; hash: string }>;
const FORK_CHECKPOINTS: ChainCheckpoints = {
  btc: {
    height: 961_640,
    hash: "00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00",
  },
  blake: {
    height: 961_640,
    hash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb",
  },
};

/** Verifies each backend identity once per URL, then returns a fresh chain tip. */
export class ChainVerifier {
  #verifiedCheckpoints = new Set<string>();
  constructor(private readonly checkpoints: ChainCheckpoints = FORK_CHECKPOINTS) {}

  async verifiedTip(chain: ChainId, client: EsploraClient): Promise<ChainTip> {
    const height = await client.tipHeight();
    const checkpoint = this.checkpoints[chain];
    if (height < checkpoint.height) {
      throw new Error(`${chain.toUpperCase()} backend is behind the required fork checkpoint`);
    }
    const checkpointKey = `${chain}:${client.baseUrl}:${checkpoint.height}:${checkpoint.hash}`;
    if (!this.#verifiedCheckpoints.has(checkpointKey)) {
      const actual = await client.blockHash(checkpoint.height);
      if (actual !== checkpoint.hash) {
        throw new Error(`${chain.toUpperCase()} backend failed the fork checkpoint`);
      }
      this.#verifiedCheckpoints.add(checkpointKey);
    }
    return { height, fetchedAt: new Date().toISOString() };
  }
}
