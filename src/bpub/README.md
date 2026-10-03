# Portable BPUB v5 codec

`mod.ts` is the public entry point. This directory deliberately has no wallet, filesystem, UI,
network, Deno or Node imports. Its only dependencies are Noble's portable hashes and curve
implementations. Raw DEFLATE is injected through `BpubCompression` so consumers can use their
runtime's compression implementation.

Encoding, decoding, content IDs and BPUB script construction live here. BLAKE signatures, fees, UTXO
selection and publication persistence belong to `src/core`. This boundary is intended for extraction
into a JSR/npm package; nothing is published as part of this feature.

Wire-format reference: djkazic/bpub commit `8b1ff26adf336bbd6a0e8a9f0a8b90f7323cbc62`,
docs/01_spec.md and bpub.py.
