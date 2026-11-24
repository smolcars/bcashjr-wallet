# Portable BPUB v5 codec

`mod.ts` is the public entry point. This directory deliberately has no wallet, filesystem, UI,
network, Deno or Node imports. Its only dependencies are Noble's portable hashes and curve
implementations. Raw DEFLATE is injected through `BpubCompression` so consumers can use their
runtime's compression implementation.

Encoding, decoding, content IDs and BPUB script construction live here. BLAKE signatures, fees, UTXO
selection and publication persistence belong to `src/core`. This boundary is intended for extraction
into a JSR/npm package; nothing is published as part of this feature.

Wire-format reference: djkazic/bpub commit `be8ba03b6ca7ed3d8239bffbd6591d3708c932f8`,
docs/01_spec.md and bpub.py.
