import { useEffect, useRef, useState } from "react";
import { base64 } from "@scure/base";
import type { BpubPreview, WalletSnapshot } from "../core/types.ts";
import {
  BPUB_IMAGE_TYPES,
  BPUB_MAX_FILE_BYTES,
  BPUB_MIN_FEE_RATE,
  BPUB_MIN_OWNER_VALUE,
  BPUB_OWNER_VALUE,
} from "../core/bpub_limits.ts";
import { walletApi } from "./bridge.ts";
import { Amount } from "./Amount.tsx";
import { errorMessage, Spinner } from "./shared.tsx";
import { transactionPage } from "./explorer_url.ts";

interface Props {
  snapshot: WalletSnapshot;
  active: boolean;
  busy: string;
  setBusy(value: string): void;
  setSnapshot(value: WalletSnapshot): void;
  onError(value: string): void;
}
interface Picture {
  filename: string;
  mime: string;
  size: number;
  dataBase64: string;
}

export function BpubScreen({ snapshot, active, busy, setBusy, setSnapshot, onError }: Props) {
  const [picture, setPicture] = useState<Picture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [feeRate, setFeeRate] = useState("");
  const [ownerValue, setOwnerValue] = useState(String(BPUB_OWNER_VALUE));
  const [preview, setPreview] = useState<BpubPreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const fileVersion = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const infoDialog = useRef<HTMLDialogElement>(null);
  const selectable = new Set(snapshot.selectableBlakeOutpoints);
  const coins = snapshot.outputs.filter((o) => selectable.has(o.outpoint));
  const chosen = selected.filter((o) => selectable.has(o));
  const allCoinsSelected = coins.length > 0 &&
    coins.every((coin) => chosen.includes(coin.outpoint));
  const selectedValue = coins.reduce(
    (sum, coin) => sum + (chosen.includes(coin.outpoint) ? coin.value : 0),
    0,
  );

  useEffect(() => {
    if (!active) infoDialog.current?.close();
  }, [active]);

  useEffect(() => {
    if (!active && preview) {
      void walletApi.cancelBpubPreview(preview.id).catch(() => {});
      setPreview(null);
    }
  }, [active, preview]);

  async function choose(file: File | undefined) {
    const version = ++fileVersion.current;
    setPicture(null);
    onError("");
    if (!file) return;
    if (file.size === 0 || file.size > BPUB_MAX_FILE_BYTES) {
      onError(
        "Choose a picture between 1 byte and 128 KiB. Resize larger pictures before selecting them.",
      );
      return;
    }
    const extensions: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mime = file.type || extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
    if (!(BPUB_IMAGE_TYPES as readonly string[]).includes(mime)) {
      onError("Choose a PNG, JPEG, GIF or WebP picture.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (version === fileVersion.current) {
        setPicture({
          filename: file.name,
          mime,
          size: bytes.length,
          dataBase64: base64.encode(bytes),
        });
      }
    } catch (error) {
      if (version === fileVersion.current) onError(errorMessage(error));
    }
  }

  async function run(name: string, operation: () => Promise<void>) {
    setBusy(name);
    onError("");
    try {
      await operation();
    } catch (error) {
      onError(errorMessage(error));
      // A rejected request may still have saved/broadcast the funding transaction.
      try {
        setSnapshot(await walletApi.snapshot());
      } catch { /* Preserve the original error. */ }
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="dashboard bpub-workspace" hidden={!active}>
      <section className="card bpub-intro">
        <h1>Publish a picture</h1>
        <p>
          This BLAKE-chain spammer publishes pictures directly on-chain using{" "}
          <a href="https://github.com/djkazic/bpub" target="_blank" rel="noreferrer">BPUB</a>. Your
          picture is split into small pieces and embedded in transaction scripts. The wallet makes
          two transactions: one to fund the publication, and another to reveal the picture's data
          on-chain so others can reconstruct it.
        </p>
        <p>
          Choose a picture and the BLAKE coins to fund it, then review the fees for both the funding
          and reveal transactions. Unused funds return to your wallet as change, while a separate
          output records BPUB ownership. Both transactions use SIGHASH_UNIFIED replay protection;
          your BTC copies are not spent.
        </p>
        <p>
          Supports one picture per publication, up to 128 KiB. The original file and its embedded
          metadata become public, so only publish content you intend to share permanently.
        </p>
        <button
          type="button"
          className="secondary"
          aria-haspopup="dialog"
          aria-controls="bpub-info"
          onClick={() => infoDialog.current?.showModal()}
        >
          Learn more
        </button>
      </section>
      <dialog
        ref={infoDialog}
        id="bpub-info"
        className="modal bpub-info-modal"
        aria-labelledby="bpub-info-title"
      >
        <h2 id="bpub-info-title">How BPUB stores your picture</h2>
        <h3>File bytes become public keys</h3>
        <p>
          A compressed secp256k1 public key is 33 bytes: a one-byte prefix followed by a 32-byte
          x-coordinate. BPUB splits its encoded file stream into 31-byte chunks and builds each
          data-carrying key as{" "}
          <code>[prefix | 31 bytes of data | 1-byte nonce]</code>. It varies only the nonce until
          the x-coordinate corresponds to a point on the curve, then adds the appropriate prefix.
          The 31 data bytes stay unchanged. These are valid public keys, but BPUB does not know
          their private keys.
        </p>
        <h3>The wallet adds a key it can spend with</h3>
        <p>
          Up to 14 data-carrying keys are placed alongside one wallet-controlled key in each 1-of-N
          multisig witness script. Only one signature is needed, so the wallet can spend using its
          own key without knowing the private keys of the data-carrying keys.
        </p>
        <h3>Funding commits; revealing publishes</h3>
        <p>
          The funding transaction creates P2WSH outputs containing the scripts' SHA-256 hashes. The
          reveal transaction spends those outputs and includes the full scripts in its witness. A
          reader can then extract the 31 data bytes from each key, reassemble the stream, and decode
          it to recover the original file. The funding hashes alone do not contain the file.
        </p>
        <p>
          Unused funds return as separate funding and reveal change outputs, when present. A
          separate ownership output records your BPUB item and is kept out of ordinary wallet
          spending. Both transactions use BLAKE's SIGHASH_UNIFIED replay protection, making them
          invalid on Bitcoin.
        </p>
        <p>
          Read the protocol and reference code on{" "}
          <a href="https://github.com/djkazic/bpub" target="_blank" rel="noreferrer">
            BPUB's GitHub
          </a>.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => infoDialog.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
      <div className="bpub-columns">
        <section className="card bpub-card">
          <h2>1. Choose a picture</h2>
          <input
            ref={input}
            type="file"
            accept={BPUB_IMAGE_TYPES.join(",")}
            className="bpub-file-input"
            disabled={Boolean(busy)}
            aria-label="Choose BPUB picture"
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="secondary"
            disabled={Boolean(busy)}
            onClick={() => input.current?.click()}
          >
            {picture ? "Change picture" : "Choose picture"}
          </button>
          <p className="muted">PNG, JPEG, GIF or WebP · up to 128 KiB · original file preserved</p>
          {picture && (
            <figure className="bpub-picture">
              <img
                src={`data:${picture.mime};base64,${picture.dataBase64}`}
                alt="Selected picture"
              />
              <figcaption>
                {picture.filename} ·{" "}
                {(picture.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB
              </figcaption>
            </figure>
          )}
          <p className="bpub-warning">
            Publishing makes the file and its embedded metadata public and permanent. Do not select
            private pictures.
          </p>
        </section>
        <section className="card bpub-card">
          <h2>2. Choose BLAKE coins</h2>
          <p className="muted">
            Unused funds return to this wallet as change. Shared coins are split using
            SIGHASH_UNIFIED; no Bitcoin transaction is broadcast.
          </p>
          <div className="bpub-coin-picker">
            <div className="bpub-coin-toolbar">
              <span>{coins.length} UTXO{coins.length === 1 ? "" : "s"}</span>
              <button
                type="button"
                className="text-button"
                disabled={Boolean(busy) || coins.length === 0}
                onClick={() =>
                  setSelected(allCoinsSelected ? [] : coins.map((coin) => coin.outpoint))}
              >
                {allCoinsSelected ? "Clear" : "Select available"}
              </button>
            </div>
            <div className="bpub-coin-list">
              {coins.map((coin) => (
                <div className="bpub-coin-row" key={coin.outpoint}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${coin.outpoint}`}
                    disabled={Boolean(busy)}
                    checked={chosen.includes(coin.outpoint)}
                    onChange={() =>
                      setSelected(
                        chosen.includes(coin.outpoint)
                          ? chosen.filter((o) => o !== coin.outpoint)
                          : [...chosen, coin.outpoint],
                      )}
                  />
                  <span className="bpub-coin-identity">
                    <a
                      className="tx-link"
                      href={transactionPage(snapshot.settings.blakeApiUrl, coin.txid)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open on the BLAKE explorer"
                    >
                      <code>{coin.txid}</code>
                    </a>
                    <small>Output {coin.vout} · {coin.path}</small>
                  </span>
                  <span className="bpub-coin-meta">
                    <strong>
                      <Amount value={coin.value} />
                    </strong>
                    <small>{coin.blake.tx?.confirmations ?? "—"} conf.</small>
                  </span>
                </div>
              ))}
              {!coins.length && (
                <div className="bpub-coin-empty">
                  <strong>No eligible BLAKE coins</strong>
                  <small>Sync after funding or confirmation.</small>
                </div>
              )}
            </div>
          </div>
          <div className="bpub-selection-summary">
            <span>{chosen.length} selected</span>
            <strong>
              <Amount value={selectedValue} />
            </strong>
          </div>
          <div className="bpub-option-fields">
            <label className="bpub-option-field bpub-owner-field">
              <span className="bpub-option-label">
                Ownership amount <small>sats · per picture</small>
              </span>
              <input
                type="number"
                min={BPUB_MIN_OWNER_VALUE}
                step="1"
                value={ownerValue}
                disabled={Boolean(busy)}
                onChange={(event) => setOwnerValue(event.target.value)}
              />
            </label>
            <label className="bpub-option-field bpub-fee-field">
              <span className="bpub-option-label">
                Fee rate <small>sat/vB</small>
              </span>
              <input
                type="number"
                min={BPUB_MIN_FEE_RATE}
                max="100"
                step="0.1"
                placeholder="Auto"
                disabled={Boolean(busy)}
                value={feeRate}
                onChange={(event) => setFeeRate(event.target.value)}
              />
            </label>
          </div>
          <p className="muted bpub-owner-help">
            BPUB v5 requires one ownership output per item. Minimum {BPUB_MIN_OWNER_VALUE}{" "}
            sats. This is not a fee; it stays reserved in your ownership output, which this wallet
            cannot spend yet.
          </p>
          <button
            type="button"
            className="primary wide bpub-review-button"
            disabled={Boolean(busy) || !picture || !chosen.length || !snapshot.recoveryScanComplete}
            onClick={() =>
              void run("bpub-review", async () => {
                if (!picture) return;
                const next = await walletApi.previewBpub({
                  ...picture,
                  outpoints: chosen,
                  ownerValue: Number(ownerValue),
                  ...(feeRate ? { feeRate: Number(feeRate) } : {}),
                });
                setAccepted(false);
                setPreview(next);
              })}
          >
            {busy === "bpub-review" && <Spinner />}Review publication
          </button>
        </section>
      </div>
      {snapshot.publications.length > 0 && (
        <section className="card bpub-card">
          <h2>Your publications</h2>
          {snapshot.publications.slice().reverse().map((publication) => (
            <article className="bpub-publication" key={publication.id}>
              <div>
                <strong>{publication.filename}</strong>
                <small>
                  {publication.size.toLocaleString()} bytes · Fees{" "}
                  <Amount value={publication.totalFee} />
                </small>
              </div>
              {publication.fundingPhase !== "abandoned" && (
                <>
                  <div className="bpub-progress">
                    <a
                      href={transactionPage(snapshot.settings.blakeApiUrl, publication.fundingTxid)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Funding: {publication.fundingPhase}
                    </a>
                    <a
                      href={transactionPage(snapshot.settings.blakeApiUrl, publication.revealTxid)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Reveal: {publication.revealPhase}
                    </a>
                  </div>
                  {!(publication.fundingPhase === "confirmed" &&
                    publication.revealPhase === "confirmed") && (
                    <small>
                      Data outputs: {publication.dataUnspent === null
                        ? "not verified"
                        : <Amount value={publication.dataUnspent} />} · Ownership:{" "}
                      {publication.ownerUnspent === null
                        ? "not verified"
                        : <Amount value={publication.ownerUnspent} />}{" "}
                      (kept separate from spendable coins)
                    </small>
                  )}
                </>
              )}
              {publication.lastError && <p className="error-box">{publication.lastError}</p>}
              {(publication.revealPhase === "seen" || publication.revealPhase === "confirmed") && (
                <a
                  className="secondary compact bpub-view-picture"
                  href={`https://bitfiles.io/btcb2/${publication.revealTxid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View picture on Bitfiles (opens in your browser)"
                >
                  View picture
                </a>
              )}
              {!(publication.fundingPhase === "confirmed" &&
                publication.revealPhase === "confirmed") &&
                publication.fundingPhase !== "abandoned" && (
                <button
                  type="button"
                  className="secondary compact"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(
                      `bpub-resume-${publication.id}`,
                      async () => setSnapshot(await walletApi.resumeBpub(publication.id)),
                    )}
                >
                  {busy === `bpub-resume-${publication.id}` && <Spinner />}Check / Resume
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section
            className="modal bpub-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bpub-review-title"
          >
            <div className="eyebrow">BLAKE ONLY</div>
            <h2 id="bpub-review-title">Review publication</h2>
            <p>
              {preview.filename} · {preview.size.toLocaleString()} bytes · {preview.dataOutputCount}
              {" "}
              data outputs
            </p>
            <dl>
              <dt>Funding fee</dt>
              <dd>
                <Amount value={preview.fundingFee} />
              </dd>
              <dt>Reveal fee</dt>
              <dd>
                <Amount value={preview.revealFee} />
              </dd>
              <dt>Total fees</dt>
              <dd>
                <Amount value={preview.fundingFee + preview.revealFee} />
              </dd>
              <dt>Wallet change from funding</dt>
              <dd>
                <Amount value={preview.fundingChange} />
              </dd>
              <dt>Wallet change from reveal</dt>
              <dd>
                <Amount value={preview.revealReturn} />
              </dd>
              <dt>Total returned to wallet</dt>
              <dd>
                <Amount value={preview.fundingChange + preview.revealReturn} />
              </dd>
              <dt>Reserved for BPUB ownership</dt>
              <dd>
                <Amount value={preview.ownerValue} />
              </dd>
            </dl>
            <p className="muted">
              Both transactions use {preview.feeRate}{" "}
              sat/vB. Reveal sizing is conservative; the approved absolute fee will not increase.
              Ownership funds remain separate; ownership transfers are not supported yet.
            </p>
            <p className="bpub-warning">
              This publishes the original file, including metadata. Both signed transactions are
              saved locally before broadcasting. Keep the wallet data to resume an interrupted
              publication.
            </p>
            {preview.highFee && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>I accept the unusually high publication fee.</span>
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() => {
                  void walletApi.cancelBpubPreview(preview.id).catch(() => {});
                  setPreview(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(busy) || (preview.highFee && !accepted)}
                onClick={() =>
                  void run("bpub-publish", async () => {
                    const id = preview.id;
                    setPreview(null);
                    setSnapshot(await walletApi.confirmBpub(id, accepted));
                    setSelected([]);
                  })}
              >
                {busy === "bpub-publish" && <Spinner />}Publish on BLAKE
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
