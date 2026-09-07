import { formatAmount } from "./shared.tsx";

Deno.test("amounts can be displayed in sats, BTC, or BIP177 bitcoin", () => {
  const cases = [
    { value: 3_370, unit: "sat" as const, expected: "3,370 sats" },
    { value: 3_370, unit: "btc" as const, expected: "0.00003370 BTC" },
    { value: 100_000_000, unit: "btc" as const, expected: "1.00000000 BTC" },
    { value: 0, unit: "bip177" as const, expected: "₿ 0" },
    { value: 1, unit: "bip177" as const, expected: "₿ 1" },
    { value: 10_000, unit: "bip177" as const, expected: "₿ 10,000" },
    { value: 500_000, unit: "bip177" as const, expected: "₿ 500,000" },
    { value: 100_000_000, unit: "bip177" as const, expected: "₿ 100,000,000" },
    { value: 1_023_486_000, unit: "bip177" as const, expected: "₿ 1,023,486,000" },
    { value: 2_100_000_000_000_000, unit: "bip177" as const, expected: "₿ 2,100,000,000,000,000" },
  ];

  for (const { value, unit, expected } of cases) {
    const actual = formatAmount(value, unit, "en-US");
    if (actual !== expected) {
      throw new Error(`Expected ${expected}, got ${actual}`);
    }
  }
});

Deno.test("amount formatting defaults to the runtime locale", () => {
  const value = 2_673_771;
  const integerAmount = new Intl.NumberFormat().format(value);
  const btcAmount = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(value / 100_000_000);
  if (
    formatAmount(value, "bip177") !== `₿ ${integerAmount}` ||
    formatAmount(value, "sat") !== `${integerAmount} sats` ||
    formatAmount(value, "btc") !== `${btcAmount} BTC`
  ) throw new Error("Amount formatting did not follow the runtime locale");
});

Deno.test("amount formatting respects locale-specific grouping and decimal separators", () => {
  const cases = [
    { locale: "sv-SE", unit: "bip177" as const, expected: "₿ 2\u00a0673\u00a0771" },
    { locale: "sv-SE", unit: "sat" as const, expected: "2\u00a0673\u00a0771 sats" },
    { locale: "sv-SE", unit: "btc" as const, expected: "0,02673771 BTC" },
    { locale: "de-DE", unit: "bip177" as const, expected: "₿ 2.673.771" },
    { locale: "de-DE", unit: "btc" as const, expected: "0,02673771 BTC" },
  ];
  for (const { locale, unit, expected } of cases) {
    const actual = formatAmount(2_673_771, unit, locale);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
  }
});
