import { renderToStaticMarkup } from "react-dom/server";
import { emptyPublicState } from "../core/types.ts";
import { buildWalletSnapshot } from "../core/wallet_snapshot.ts";
import { BpubScreen } from "./BpubScreen.tsx";
import { AmountUnitProvider } from "./Amount.tsx";

Deno.test("each BPUB picture link uses its reveal transaction on Bitfiles", () => {
  const snapshot = buildWalletSnapshot(emptyPublicState(), "unlocked");
  snapshot.publications = ["1", "2"].map((digit) => ({
    id: digit,
    filename: `picture-${digit}.jpg`,
    size: 100,
    bpubId: digit.repeat(64),
    fundingTxid: "a".repeat(64),
    revealTxid: digit.repeat(64),
    fundingPhase: "confirmed",
    revealPhase: "confirmed",
    totalFee: 1000,
    dataUnspent: 0,
    ownerUnspent: 330,
  }));
  snapshot.publications.push({
    ...snapshot.publications[0],
    id: "3",
    revealTxid: "3".repeat(64),
    fundingPhase: "abandoned",
    revealPhase: "prepared",
    lastError: "Funding was superseded by another transaction; the picture was not published.",
  });
  snapshot.publications.push({
    ...snapshot.publications[0],
    id: "4",
    revealTxid: "4".repeat(64),
    fundingPhase: "seen",
    revealPhase: "prepared",
  });
  const markup = renderToStaticMarkup(
    <AmountUnitProvider unit="btc">
      <BpubScreen
        snapshot={snapshot}
        active
        busy=""
        setBusy={() => {}}
        setSnapshot={() => {}}
        onError={() => {}}
      />
    </AmountUnitProvider>,
  );
  const links = [...markup.matchAll(/<a\b[^>]*>View picture<\/a>/gu)];
  if (links.length !== 2) throw new Error("Each publication needs a picture link");
  for (const publication of snapshot.publications.slice(0, 2)) {
    if (
      !links.some(([link]) =>
        link.includes(`href="https://bitfiles.io/btcb2/${publication.revealTxid}"`) &&
        link.includes('target="_blank"') && link.includes('rel="noopener noreferrer"')
      )
    ) {
      throw new Error("Picture link must open the reveal transaction on Bitfiles safely");
    }
  }
  const completed = [...markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gu)]
    .map(([article]) => article)
    .find((article) => article.includes("picture-2.jpg"));
  if (!completed || completed.includes("Data outputs:") || completed.includes("Ownership:")) {
    throw new Error("Completed publications must not show stale output observations");
  }
  const failed = [...markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gu)]
    .map(([article]) => article)
    .find((article) => article.includes("the picture was not published."));
  if (!failed || failed.includes("View picture") || failed.includes("Check / Resume")) {
    throw new Error("Superseded publication must show its failure without publication actions");
  }
  const pending = [...markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gu)]
    .map(([article]) => article)
    .find((article) => article.includes("picture-1.jpg") && article.includes("Funding: seen"));
  if (!pending || pending.includes("View picture") || !pending.includes("Check / Resume")) {
    throw new Error("Pending reveal must offer Resume without a broken picture link");
  }
});

Deno.test("wallet and spammer use shared top spacing without an extra balance-grid offset", async () => {
  const css = await Deno.readTextFile(new URL("./styles.css", import.meta.url));
  const dashboard = css.match(/\.dashboard\s*\{([^}]+)\}/u)?.[1] ?? "";
  const balances = css.match(/\.balance-grid\s*\{([^}]+)\}/u)?.[1] ?? "";
  if (!dashboard.includes("padding: 6px 20px 14px;") || !balances.includes("margin: 0 0 14px;")) {
    throw new Error("Keep top spacing on the shared dashboard container, not its first card");
  }
});

Deno.test("BPUB screen is BLAKE-only and requires a file and selected coins before review", () => {
  const props = {
    snapshot: buildWalletSnapshot(emptyPublicState(), "unlocked"),
    busy: "",
    setBusy: () => {},
    setSnapshot: () => {},
    onError: () => {},
  };
  const render = (active: boolean) =>
    renderToStaticMarkup(
      <AmountUnitProvider unit="btc">
        <BpubScreen {...props} active={active} />
      </AmountUnitProvider>,
    );
  const markup = render(true);
  for (
    const expected of [
      'class="dashboard bpub-workspace"',
      'type="file"',
      'accept="image/png,image/jpeg,image/gif,image/webp"',
      "BLAKE-chain spammer",
      "31-byte chunk",
      "[prefix | 31 bytes of data | 1-byte nonce]",
      "The funding hashes alone do not contain the file.",
      "1-of-N multisig witness",
      "P2WSH outputs",
      'href="https://github.com/djkazic/bpub"',
      'aria-haspopup="dialog"',
      'aria-controls="bpub-info"',
      "Learn more",
      "one picture per publication",
      "Ownership amount",
      'min="1"',
      'min="330"',
      'value="330"',
      "public and permanent",
      "No eligible BLAKE coins",
      'disabled="">Review publication',
    ]
  ) {
    if (!markup.includes(expected)) throw new Error(`Missing BPUB UI guard: ${expected}`);
  }
  if (markup.includes("BLAKE ONLY · BPUB V5")) {
    throw new Error("Removed BPUB intro label returned");
  }
  const intro = markup.match(/<section class="card bpub-intro">([\s\S]*?)<\/section>/u)?.[1] ?? "";
  const dialog = markup.match(/<dialog\b([^>]*)>([\s\S]*?)<\/dialog>/u);
  if (!intro.includes("small pieces") || intro.includes("secp256k1")) {
    throw new Error("Keep the main explanation friendly and the technical detail in Learn more");
  }
  if (
    !dialog || /\bopen(?:=|\s|$)/u.test(dialog[1]) ||
    !dialog[1].includes('aria-labelledby="bpub-info-title"') ||
    !dialog[2].includes("31-byte chunks") || !dialog[2].includes(">Close</button>")
  ) {
    throw new Error("BPUB details need a labelled, initially closed dialog with a close button");
  }
  if (markup.includes("not encrypted with them")) {
    throw new Error("Removed encryption aside returned");
  }
  if (!render(false).includes('hidden=""')) {
    throw new Error("Inactive BPUB screen must be hidden");
  }
});

Deno.test("BPUB coin selection uses a self-contained picker and aligned publication options", () => {
  const snapshot = buildWalletSnapshot(emptyPublicState(), "unlocked");
  const txid = "12".repeat(32);
  const checkedAt = new Date(0).toISOString();
  const outpoint = `${txid}:1`;
  snapshot.outputs = [{
    outpoint,
    txid,
    vout: 1,
    value: 42_000,
    address: "bc1ptest",
    scriptPubKey: `5120${"34".repeat(32)}`,
    path: "m/86'/0'/0'/0/7",
    wasShared: true,
    splitState: "unsplit",
    blake: {
      checkedAt,
      backendOk: true,
      tx: { present: true, confirmed: true, confirmations: 6 },
      unspent: true,
    },
    btc: {
      checkedAt,
      backendOk: true,
      tx: { present: true, confirmed: true, confirmations: 6 },
      unspent: true,
    },
  }];
  snapshot.selectableBlakeOutpoints = [outpoint];

  const markup = renderToStaticMarkup(
    <AmountUnitProvider unit="btc">
      <BpubScreen
        snapshot={snapshot}
        active
        busy=""
        setBusy={() => {}}
        setSnapshot={() => {}}
        onError={() => {}}
      />
    </AmountUnitProvider>,
  );

  for (
    const expected of [
      'class="bpub-coin-picker"',
      'class="bpub-coin-toolbar"',
      "1 UTXO",
      "Select available",
      'class="bpub-coin-list"',
      'class="bpub-coin-row"',
      `aria-label="Select ${outpoint}"`,
      "Output 1 · m/86&#x27;/0&#x27;/0&#x27;/0/7",
      "6 conf.",
      'class="bpub-selection-summary"',
      'class="bpub-option-fields"',
      'class="bpub-option-field bpub-owner-field"',
      'class="bpub-option-field bpub-fee-field"',
      'class="muted bpub-owner-help"',
      'class="primary wide bpub-review-button"',
    ]
  ) {
    if (!markup.includes(expected)) throw new Error(`Missing structured BPUB control: ${expected}`);
  }
  if (markup.includes('class="utxo-list"') || markup.includes('class="utxo-row')) {
    throw new Error("BPUB picker must not inherit the wallet panel's constrained viewport classes");
  }
});
