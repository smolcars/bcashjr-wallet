import type { AmountUnit, SplitState } from "../core/types.ts";

const stateLabels: Record<SplitState, string> = {
  confirming: "Confirming",
  unsplit: "Shared",
  "blake-only": "BLAKE only",
  "btc-only": "BTC only",
  "split-pending": "Split pending",
  split: "Split",
  spent: "Spent",
  unknown: "Unknown",
};

export function formatAmount(value: number, unit: AmountUnit, locale?: string): string {
  if (unit === "btc") {
    return `${
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 8,
        maximumFractionDigits: 8,
      }).format(value / 100_000_000)
    } BTC`;
  }
  const integerAmount = new Intl.NumberFormat(locale).format(value);
  return unit === "bip177" ? `₿ ${integerAmount}` : `${integerAmount} sats`;
}

export function shorten(value: string, side = 9): string {
  return value.length <= side * 2 + 1 ? value : `${value.slice(0, side)}…${value.slice(-side)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function StateBadge({ state }: { state: SplitState }) {
  return <span className={`state-badge state-${state}`}>{stateLabels[state]}</span>;
}
