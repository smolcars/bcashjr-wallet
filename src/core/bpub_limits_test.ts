import { bpubNeedsConfirmedFunding } from "./bpub_limits.ts";

Deno.test("BPUB confirmation gate counts funding and reveal against the ancestor limit", () => {
  if (bpubNeedsConfirmedFunding({ fundingVsize: 20000, revealVsize: 81000 })) {
    throw new Error("The exact ancestor limit should fit");
  }
  if (!bpubNeedsConfirmedFunding({ fundingVsize: 20000, revealVsize: 81001 })) {
    throw new Error("Individually standard transactions can exceed their combined ancestor limit");
  }
});
