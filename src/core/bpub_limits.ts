// Absolute encoding/state bounds, retained for legacy publications. New padded reveals
// must also fit the transaction weight limit checked by createBpubTemplate.
export const BPUB_MAX_REVEAL_INPUTS = 500;
export const BPUB_MAX_STREAM_BYTES = BPUB_MAX_REVEAL_INPUTS * 14 * 31;
export const BPUB_ANCESTOR_VSIZE_LIMIT = 101_000;
export function bpubNeedsConfirmedFunding(
  sizes: { fundingVsize: number; revealVsize: number },
): boolean {
  return sizes.fundingVsize + sizes.revealVsize > BPUB_ANCESTOR_VSIZE_LIMIT;
}
export const BPUB_MIN_FEE_RATE = 1;
// P2WSH dust threshold at the standard dust relay fee.
export const BPUB_MIN_OWNER_VALUE = 330;
export const BPUB_OWNER_VALUE = BPUB_MIN_OWNER_VALUE;
export const BPUB_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
