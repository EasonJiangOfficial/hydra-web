import { cn } from "@/lib/utils";

export type MoneyFormat = {
  /** Prefix positive amounts with "+". */
  signed?: boolean;
  /** `$31.8k`, `$1.2M`. Under $1,000 shows whole dollars. */
  compact?: boolean;
  /** Drop the cents: `$2,318`. */
  whole?: boolean;
};

const group = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Splits integer cents into sign, dollar text and cent text ("" when hidden). Rounds half away from zero. */
export function moneyParts(cents: number, opts: MoneyFormat = {}): { sign: string; main: string; cents: string } {
  const c = Math.round(Math.abs(cents)) * Math.sign(cents);
  const abs = Math.abs(c);
  const sign = c < 0 ? "-" : c > 0 && opts.signed ? "+" : "";

  if (opts.compact) {
    const dollars = Math.round(abs / 100);
    if (dollars < 1000) return { sign: dollars === 0 ? "" : sign, main: `$${dollars}`, cents: "" };
    const k = Math.round(dollars / 100) / 10; // thousands, one decimal
    if (k < 1000) return { sign, main: `$${trim(k)}k`, cents: "" };
    return { sign, main: `$${trim(Math.round(dollars / 100_000) / 10)}M`, cents: "" };
  }

  if (opts.whole) {
    const dollars = Math.round(abs / 100);
    return { sign: dollars === 0 ? "" : sign, main: `$${group.format(dollars)}`, cents: "" };
  }

  const dollars = Math.floor(abs / 100);
  return { sign, main: `$${group.format(dollars)}`, cents: `.${String(abs % 100).padStart(2, "0")}` };
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** Integer cents to text: `$48,212.40`, `-$2,318` (whole), `+$2,104.18` (signed), `$31.8k` (compact). */
export function formatMoney(cents: number, opts: MoneyFormat = {}): string {
  const p = moneyParts(cents, opts);
  return p.sign + p.main + p.cents;
}

export type MoneyProps = MoneyFormat & {
  /** Integer cents. */
  cents: number;
  /** Cents at 45% opacity (the hero figure). */
  dimCents?: boolean;
  /** Inherits the surrounding ink by default; red only for money lost or overdue. */
  tone?: "default" | "loss";
  className?: string;
};

export function Money({ cents, dimCents, tone = "default", className, ...fmt }: MoneyProps) {
  const p = moneyParts(cents, fmt);
  return (
    <span className={cn("tabular-nums", tone === "loss" && "text-neg", className)}>
      {p.sign}
      {p.main}
      {p.cents && (dimCents ? <span className="opacity-45">{p.cents}</span> : p.cents)}
    </span>
  );
}
