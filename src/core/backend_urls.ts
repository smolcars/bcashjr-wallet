import { normalizeEsploraUrl } from "./esplora.ts";

export const DEFAULT_BLAKE_API_URL = "https://mempool.kilombino.com/api";
export const BACKEND_MIGRATION_VERSION = 1;

/** One-time default migration; explicit choices after migration remain untouched. */
export function migrateBlakeBackend(value: string): string {
  const hostname = new URL(normalizeEsploraUrl(value)).hostname.replace(/\.$/u, "");
  return hostname === "mempool.guide" || hostname === "www.mempool.guide"
    ? DEFAULT_BLAKE_API_URL
    : value;
}
