import fixtures from "../../testdata/bpub_v5.json" with { type: "json" };
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  bpubDataScripts,
  bpubId,
  bpubPaddingItems,
  decodeBpub,
  encodeBpub,
  encodeDataKeys,
  parseBpubScript,
} from "./mod.ts";
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
const compression = {
  deflate: (data: Uint8Array) => Uint8Array.from(deflateRawSync(data, { level: 9 })),
  inflate: (data: Uint8Array, maxOutputBytes: number) =>
    Uint8Array.from(inflateRawSync(data, { maxOutputLength: maxOutputBytes })),
};
Deno.test("portable BPUB v5 matches upstream Python streams, keys and scripts", () => {
  for (const fixture of fixtures.fixtures) {
    const encoded = encodeBpub(fromHex(fixture.data), fixture, compression);
    if (
      encoded.id !== fixture.id || hex(encoded.stream) !== fixture.stream ||
      JSON.stringify(encoded.publicKeys.map(hex)) !== JSON.stringify(fixture.keys) ||
      JSON.stringify(
          bpubDataScripts(encoded.publicKeys, fromHex(fixtures.control), true).map(hex),
        ) !==
        JSON.stringify(fixture.scripts)
    ) {
      throw new Error(`Python interoperability mismatch for ${fixture.filename}`);
    }
    const decoded = decodeBpub(encoded.publicKeys, compression, 4096);
    if (hex(decoded.data) !== fixture.data || decoded.metadata.filename !== fixture.filename) {
      throw new Error("Round-trip failed");
    }
  }
});
Deno.test("BPUB decoding rejects corruption and excessive inflation", () => {
  const fixture = fixtures.fixtures[2];
  for (const limit of [0, 10]) {
    let rejected = false;
    try {
      decodeBpub(fixture.keys.map(fromHex), compression, limit);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Missing decompression bound");
  }
  const damaged = fromHex(fixture.stream);
  damaged[14] ^= 1;
  let rejected = false;
  try {
    decodeBpub(encodeDataKeys(damaged), compression, 4096);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Missing content hash check");
});

Deno.test("BPUB encoder accepts only metadata its decoder can inflate", () => {
  const data = new Uint8Array();
  const metadataOverhead = new TextEncoder().encode(
    JSON.stringify({ bpub_id: bpubId(data), filename: "" }),
  ).length;
  const filename = "a".repeat(65535 - metadataOverhead);
  const encoded = encodeBpub(data, { filename }, compression);
  const decoded = decodeBpub(encoded.publicKeys, compression, 0);
  if (decoded.metadata.filename !== filename) {
    throw new Error("Metadata at the decode limit did not round-trip");
  }

  let rejected = false;
  try {
    // Repeated text compresses to a tiny payload, so checking only the compressed length would
    // accept metadata that decodeBpub must reject when enforcing its inflation bound.
    encodeBpub(data, { filename: `${filename}a` }, compression);
  } catch (error) {
    rejected = error instanceof Error && error.message === "BPUB metadata is too large";
  }
  if (!rejected) throw new Error("Encoder accepted metadata beyond the decoder's limit");
});

Deno.test("BPUB padv3 uses 1-of-11 scripts with OP_1 OP_EQUAL and zero padding items", () => {
  const control = fromHex(fixtures.control);
  const dataKeys = Array.from({ length: 11 }, () => control);
  const scripts = bpubDataScripts(dataKeys, control);
  if (scripts.length !== 2) throw new Error("padv3 must chunk at 10 data keys per script");
  const first = parseBpubScript(scripts[0]);
  const second = parseBpubScript(scripts[1]);
  if (
    first.padding !== "padv3" || first.keys.length !== 11 ||
    second.padding !== "padv3" || second.keys.length !== 2
  ) throw new Error("Wrong padv3 key count or mode");
  const legacy = bpubDataScripts([control], control, true)[0];
  const single = bpubDataScripts([control], control)[0];
  if (hex(single.slice(legacy.length)) !== "5187") throw new Error("Wrong padv3 suffix");
  if (bpubPaddingItems(single).length !== 0 || bpubPaddingItems(legacy).length !== 0) {
    throw new Error("padv3 and legacy scripts must not add witness padding items");
  }
});

Deno.test("BPUB legacy padv2/padv1 parsing and deterministic DER-shaped padding remain supported", () => {
  const control = fromHex(fixtures.control);
  const script = bpubDataScripts([control], control, "padv2")[0];
  const legacy = bpubDataScripts([control], control, true)[0];
  if (
    hex(script.slice(legacy.length)) !==
      "6b8201408764" + "ac".repeat(13) + "68" + "6d".repeat(6) + "756c"
  ) throw new Error("Wrong v2 suffix");
  const pads = bpubPaddingItems(script);
  if (pads.length !== 13 || parseBpubScript(script).padding !== "padv2") {
    throw new Error("Wrong v2 padding mode");
  }
  for (const pad of pads) {
    if (
      pad.length !== 64 || hex(pad.slice(0, 4)) !== "303d021c" ||
      hex(pad.slice(32, 34)) !== "021d" || pad[63] !== 1 || !pad[4] || pad[4] > 127 || !pad[34] ||
      pad[34] > 127
    ) throw new Error("Wrong padding item");
  }
  if (
    pads.map(hex).join() !== bpubPaddingItems(script).map(hex).join() ||
    new Set(pads.map(hex)).size !== 13
  ) throw new Error("Padding is not deterministic and distinct");

  const padv1 = new Uint8Array([
    ...legacy,
    0x6b,
    ...Array(6).fill(0x6d),
    0x75,
    0x6c,
    0x51,
    0x64,
    ...Array(13).fill(0xac),
    0x68,
  ]);
  if (parseBpubScript(padv1).padding !== "padv1" || bpubPaddingItems(padv1).length !== 13) {
    throw new Error("Historical padv1 script was not recognized");
  }

  const unknown = new Uint8Array([...legacy, 0x6a]);
  if (parseBpubScript(unknown).padding !== "unknown") {
    throw new Error("Unknown suffix must be classified as unknown");
  }
  let rejected = false;
  try {
    bpubPaddingItems(unknown);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Unknown suffix must not produce padding items");
});
