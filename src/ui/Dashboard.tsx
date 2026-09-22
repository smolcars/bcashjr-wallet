import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ChainId,
  ReplayPreview,
  SpendPreview,
  SpendPurpose,
  WalletSnapshot,
} from "../core/types.ts";
import { AmountUnitProvider } from "./Amount.tsx";
import { BalanceSummary } from "./BalanceSummary.tsx";
import { BpubScreen } from "./BpubScreen.tsx";
import { walletApi } from "./bridge.ts";
import { ChainPanel } from "./ChainPanel.tsx";
import { type BroadcastNotice, DashboardNotices } from "./DashboardNotices.tsx";
import { QrScannerModal } from "./QrScannerModal.tsx";
import { ReceivePanel } from "./ReceivePanel.tsx";
import { ReplayPanel, TransactionRecovery } from "./ReplayPanels.tsx";
import { SettingsDrawer } from "./SettingsDrawer.tsx";
import { errorMessage, Spinner } from "./shared.tsx";
import { ReplayPreviewModal, SpendPreviewModal } from "./TransactionModals.tsx";

interface DashboardProps {
  snapshot: WalletSnapshot;
  setSnapshot(snapshot: WalletSnapshot): void;
}

function retained(current: Set<string>, available: string[]): Set<string> {
  const allowed = new Set(available);
  return new Set([...current].filter((outpoint) => allowed.has(outpoint)));
}

export function Dashboard({ snapshot, setSnapshot }: DashboardProps) {
  const [page, setPage] = useState<"wallet" | "bpub">("wallet");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedBtc, setSelectedBtc] = useState<Set<string>>(new Set());
  const [selectedBlake, setSelectedBlake] = useState<Set<string>>(new Set());
  const [btcDestination, setBtcDestination] = useState("");
  const [blakeDestination, setBlakeDestination] = useState("");
  const [btcFeeRate, setBtcFeeRate] = useState("");
  const [blakeFeeRate, setBlakeFeeRate] = useState("");
  const [spendPreview, setSpendPreview] = useState<SpendPreview | null>(null);
  const [replayPreview, setReplayPreview] = useState<ReplayPreview | null>(null);
  const [scannerChain, setScannerChain] = useState<ChainId | null>(null);
  const [busy, setBusy] = useState("");
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<BroadcastNotice | null>(null);

  const btcSelectable = useMemo(
    () => new Set(snapshot.selectableBtcOutpoints),
    [snapshot.selectableBtcOutpoints],
  );
  const blakeSelectable = useMemo(
    () => new Set(snapshot.selectableBlakeOutpoints),
    [snapshot.selectableBlakeOutpoints],
  );
  const btcOutputs = snapshot.outputs.filter((output) => output.btc.unspent);
  const blakeOutputs = snapshot.outputs.filter((output) => output.blake.unspent);
  const replayGroups = snapshot.replayCandidateTxids.map((txid) => ({
    txid,
    outputs: snapshot.outputs.filter((output) => output.txid === txid && output.btc.unspent),
  }));
  const recoverableIntents = snapshot.intents.filter((intent) =>
    (intent.canRebroadcast || intent.canAbandon || intent.blockedBy.length > 0) &&
    !snapshot.publications.some((p) =>
      p.fundingTxid === intent.txid || p.revealTxid === intent.txid
    )
  );

  useEffect(() => {
    setSelectedBtc((current) => retained(current, snapshot.selectableBtcOutpoints));
    setSelectedBlake((current) => retained(current, snapshot.selectableBlakeOutpoints));
  }, [
    snapshot.selectableBtcOutpoints,
    snapshot.selectableBlakeOutpoints,
  ]);

  async function action(name: string, operation: () => Promise<WalletSnapshot>) {
    setBusy(name);
    setError("");
    try {
      setSnapshot(await operation());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  function toggle(
    setter: Dispatch<SetStateAction<Set<string>>>,
    outpoint: string,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(outpoint)) next.delete(outpoint);
      else next.add(outpoint);
      return next;
    });
  }

  async function makeSpendPreview(
    event: FormEvent,
    chain: ChainId,
    purpose: SpendPurpose,
    selected: Set<string>,
    destination: string,
    feeRate: string,
  ) {
    event.preventDefault();
    setBusy(`${chain}-preview`);
    setError("");
    setSuccess(null);
    try {
      setSpendPreview(
        await walletApi.previewSpend({
          chain,
          purpose,
          outpoints: [...selected],
          destination,
          feeRate: feeRate ? Number(feeRate) : undefined,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function confirmSpend(acceptHighFee: boolean, acceptReplayRisk: boolean) {
    if (!spendPreview) return;
    const reviewed = spendPreview;
    setBusy("broadcast-spend");
    setError("");
    try {
      const result = await walletApi.confirmSpend(
        reviewed.id,
        acceptHighFee,
        acceptReplayRisk,
      );
      setSuccess({
        label: `${reviewed.purpose === "split" ? "Split" : reviewed.chain.toUpperCase()} broadcast`,
        txid: result.txid,
        chain: reviewed.chain,
      });
      if (reviewed.chain === "btc") {
        setSelectedBtc(new Set());
        setBtcDestination("");
      } else {
        setSelectedBlake(new Set());
        setBlakeDestination("");
      }
      setSpendPreview(null);
      setSnapshot(await walletApi.snapshot());
    } catch (cause) {
      setError(errorMessage(cause));
      setSpendPreview(null);
      try {
        setSnapshot(await walletApi.snapshot());
      } catch {
        // Preserve the broadcast error; a later Sync will refresh the dashboard.
      }
    } finally {
      setBusy("");
    }
  }

  async function cancelSpendPreview() {
    const preview = spendPreview;
    setSpendPreview(null);
    if (!preview) return;
    try {
      await walletApi.cancelSpendPreview(preview.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function inspectReplay(txid: string) {
    setBusy(`replay-${txid}`);
    setError("");
    setSuccess(null);
    try {
      setReplayPreview(await walletApi.previewReplay(txid));
    } catch (cause) {
      setError(errorMessage(cause));
      try {
        setSnapshot(await walletApi.snapshot());
      } catch {
        // Preserve the inspection error; a later Sync will refresh the dashboard.
      }
    } finally {
      setBusy("");
    }
  }

  async function confirmReplay() {
    if (!replayPreview) return;
    setBusy("broadcast-replay");
    setError("");
    try {
      const result = await walletApi.confirmReplay(replayPreview.id);
      setSuccess({
        label: "Funding transaction replayed to BLAKE",
        txid: result.txid,
        chain: "blake",
      });
      setReplayPreview(null);
      setSnapshot(await walletApi.snapshot());
    } catch (cause) {
      setError(errorMessage(cause));
      setReplayPreview(null);
      try {
        setSnapshot(await walletApi.snapshot());
      } catch {
        // Preserve the broadcast error; a later Sync will refresh the dashboard.
      }
    } finally {
      setBusy("");
    }
  }

  async function cancelReplayPreview() {
    const preview = replayPreview;
    setReplayPreview(null);
    if (!preview) return;
    try {
      await walletApi.cancelReplayPreview(preview.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function rebroadcastIntent(intentId: string) {
    setBusy(`rebroadcast-${intentId}`);
    setError("");
    try {
      const result = await walletApi.rebroadcastIntent(intentId);
      setSuccess({
        label: `${result.action === "split" ? "Split" : result.chain.toUpperCase()} rebroadcast`,
        txid: result.txid,
        chain: result.chain,
      });
      setSnapshot(await walletApi.snapshot());
    } catch (cause) {
      setError(errorMessage(cause));
      try {
        setSnapshot(await walletApi.snapshot());
      } catch {
        // Preserve the rebroadcast error; a later Sync will refresh the dashboard.
      }
    } finally {
      setBusy("");
    }
  }

  async function abandonIntent(intentId: string) {
    if (
      !globalThis.confirm(
        "Abandon this signed transaction only if you intend to replace it. The wallet will verify that it is absent and the original wallet outputs are restored.",
      )
    ) return;
    setBusy(`abandon-${intentId}`);
    setError("");
    try {
      setSnapshot(await walletApi.abandonIntent(intentId));
    } catch (cause) {
      setError(errorMessage(cause));
      try {
        setSnapshot(await walletApi.snapshot());
      } catch {
        // Preserve the abandonment error; a later Sync will refresh the dashboard.
      }
    } finally {
      setBusy("");
    }
  }

  return (
    <AmountUnitProvider unit={snapshot.settings.amountUnit}>
      <div className="app-shell">
        <header className="topbar">
          <nav className="screen-nav" aria-label="Wallet screens">
            <button
              type="button"
              className={page === "wallet" ? "active" : ""}
              aria-current={page === "wallet" ? "page" : undefined}
              disabled={Boolean(busy)}
              onClick={() => setPage("wallet")}
            >
              Wallet
            </button>
            <button
              type="button"
              className={page === "bpub" ? "active" : ""}
              aria-current={page === "bpub" ? "page" : undefined}
              disabled={Boolean(busy)}
              onClick={() => setPage("bpub")}
            >
              Blake Spammer
            </button>
          </nav>
          <div className="topbar-status">
            <span className="last-sync">
              {snapshot.lastSyncAt
                ? `Synced ${new Date(snapshot.lastSyncAt).toLocaleTimeString()}`
                : "Not synced"}
            </span>
            <button
              type="button"
              className="secondary compact"
              disabled={Boolean(busy)}
              onClick={() => action("sync", walletApi.sync)}
            >
              {busy === "sync" ? <Spinner /> : "↻"} Sync
            </button>
            <button
              type="button"
              className="icon-button"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
            <button
              type="button"
              className="icon-button"
              title="Lock wallet"
              aria-label="Lock wallet"
              disabled={Boolean(busy)}
              onClick={() => action("lock", walletApi.lock)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5" y="10" width="14" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                <path d="M12 14v2" />
              </svg>
            </button>
          </div>
        </header>

        <main className="dashboard wallet-workspace" hidden={page !== "wallet"}>
          <BalanceSummary snapshot={snapshot} />

          <section className="chain-panels">
            <ChainPanel
              chain="btc"
              outputs={btcOutputs}
              selectable={btcSelectable}
              selected={selectedBtc}
              destination={btcDestination}
              feeRate={btcFeeRate}
              busy={busy}
              backendApiUrl={snapshot.settings.btcApiUrl}
              walletAddress={snapshot.receiveAddress?.address}
              onToggle={(outpoint) => toggle(setSelectedBtc, outpoint)}
              onSelectAll={(outpoints) => setSelectedBtc(new Set(outpoints))}
              onDestination={setBtcDestination}
              onScanDestination={() => setScannerChain("btc")}
              onFeeRate={setBtcFeeRate}
              onReview={(event) =>
                makeSpendPreview(event, "btc", "send", selectedBtc, btcDestination, btcFeeRate)}
            />
            <ChainPanel
              chain="blake"
              outputs={blakeOutputs}
              selectable={blakeSelectable}
              selected={selectedBlake}
              destination={blakeDestination}
              feeRate={blakeFeeRate}
              busy={busy}
              backendApiUrl={snapshot.settings.blakeApiUrl}
              walletAddress={snapshot.receiveAddress?.address}
              onToggle={(outpoint) => toggle(setSelectedBlake, outpoint)}
              onSelectAll={(outpoints) => setSelectedBlake(new Set(outpoints))}
              onDestination={setBlakeDestination}
              onScanDestination={() => setScannerChain("blake")}
              onFeeRate={setBlakeFeeRate}
              onReview={(event) =>
                makeSpendPreview(
                  event,
                  "blake",
                  "send",
                  selectedBlake,
                  blakeDestination,
                  blakeFeeRate,
                )}
            />
          </section>

          {recoverableIntents.length > 0 && (
            <TransactionRecovery
              intents={recoverableIntents}
              busy={busy}
              btcApiUrl={snapshot.settings.btcApiUrl}
              blakeApiUrl={snapshot.settings.blakeApiUrl}
              onRebroadcast={rebroadcastIntent}
              onAbandon={abandonIntent}
            />
          )}

          <section className="utility-panels">
            <ReceivePanel
              snapshot={snapshot}
              busy={busy}
              onNewAddress={() => action("address", walletApi.newReceiveAddress)}
              onContinueScan={() => action("sync", walletApi.sync)}
            />
            <ReplayPanel
              groups={replayGroups}
              busy={busy}
              btcApiUrl={snapshot.settings.btcApiUrl}
              onInspect={inspectReplay}
            />
          </section>
        </main>

        <BpubScreen
          snapshot={snapshot}
          active={page === "bpub"}
          busy={busy}
          setBusy={setBusy}
          setSnapshot={setSnapshot}
          onError={setError}
        />

        <DashboardNotices
          snapshot={snapshot}
          dismissedWarnings={dismissedWarnings}
          error={error}
          success={success}
          onDismissWarning={(warning) =>
            setDismissedWarnings((current) => new Set(current).add(warning))}
          onDismissError={() => setError("")}
          onDismissSuccess={() => setSuccess(null)}
        />

        {settingsOpen && (
          <SettingsDrawer
            snapshot={snapshot}
            onClose={() => setSettingsOpen(false)}
            onSave={setSnapshot}
          />
        )}
        {scannerChain && (
          <QrScannerModal
            chain={scannerChain}
            onCancel={() => setScannerChain(null)}
            onScan={(address) => {
              if (scannerChain === "btc") setBtcDestination(address);
              else setBlakeDestination(address);
              setScannerChain(null);
            }}
          />
        )}
        {spendPreview && (
          <SpendPreviewModal
            preview={spendPreview}
            busy={busy === "broadcast-spend"}
            onCancel={() => void cancelSpendPreview()}
            onConfirm={confirmSpend}
          />
        )}
        {replayPreview && (
          <ReplayPreviewModal
            preview={replayPreview}
            busy={busy === "broadcast-replay"}
            onCancel={() => void cancelReplayPreview()}
            onConfirm={confirmReplay}
          />
        )}
      </div>
    </AmountUnitProvider>
  );
}
