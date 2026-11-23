// @vitest-environment node
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, dollars, monthlyPdf, payersCsv, taxLinesCsv, transactionsCsv, zip } from "./exports";
import { donutSlices } from "./report-tabs";
import { headline, incomeSources, monthRange, shiftMonth, trendRange, ytdRange, type ReportsData } from "./model";

const id = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("donut slices", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ name: `C${i}`, cents: 800 - i * 100, count: 1 }));
  it("six or fewer categories are six slices, one gray each", () => {
    expect(donutSlices(rows.slice(0, 6)).map((s) => s.label)).toEqual(["C0", "C1", "C2", "C3", "C4", "C5"]);
  });
  it("past six, the five largest and one more slice for the rest, so no two slices share a gray", () => {
    expect(donutSlices(rows)).toEqual([
      ...rows.slice(0, 5).map((r) => ({ label: r.name, value: r.cents, count: 1 })),
      { label: "The rest", value: 300 + 200 + 100, count: 3 },
    ]);
  });
});

describe("csv", () => {
  it("writes dollars from cents, signed, no grouping", () => {
    expect([0, 5, -5, 123456, -100].map(dollars)).toEqual(["0.00", "0.05", "-0.05", "1234.56", "-1.00"]);
  });

  it("quotes commas and quotes, and defuses spreadsheet formulas in text", () => {
    const text = transactionsCsv([
      { id: id(1), day: "2026-11-02", name: '=HYPERLINK("x")', payer: "A, B", category: "Food / Groceries", business: "UGC", cents: -1250 },
    ]);
    const [head, row] = text.trim().split("\r\n");
    expect(head).toBe("id,date,name,payer,category,business,amount");
    expect(row).toBe(`${id(1)},2026-11-02,"'=HYPERLINK(""x"")","A, B",Food / Groceries,UGC,-12.50`);
  });

  it("sums the amount column to the signed total", () => {
    const rows = [100, -40, 15].map((cents, i) => ({ id: id(i), day: "2026-11-01", name: "n", payer: "p", category: "c", business: "b", cents }));
    const sum = transactionsCsv(rows).trim().split("\r\n").slice(1).reduce((a, r) => a + Math.round(Number(r.split(",").at(-1)) * 100), 0);
    expect(sum).toBe(75);
  });

  it("writes payers and tax lines", () => {
    expect(payersCsv([{ payer: "Wordwise", cents: 320000, count: 2, share: 0.494, rowIds: [] }])).toBe("payer,transactions,amount,share_percent\r\nWordwise,2,3200.00,49.4\r\n");
    expect(taxLinesCsv([{ entityId: id(1), entitySlug: "ugc", year: 2026, taxLineId: id(2), code: "23", name: "Taxes and licenses", cents: 130000, count: 1, rowIds: [] }])).toContain("ugc,2026,23,Taxes and licenses,1,1300.00");
  });
});

describe("zip", () => {
  it("stores each file with the right size and CRC", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const a = new TextEncoder().encode("hello");
    const bytes = zip([{ name: "a.txt", bytes: a }]);
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(14, true)).toBe(crc32(a));
    expect(v.getUint32(18, true)).toBe(5);
    expect(new TextDecoder().decode(bytes.subarray(35, 40))).toBe("hello");
    expect(v.getUint16(bytes.length - 22 + 10, true)).toBe(1);
  });
});

describe("months", () => {
  it("steps and bounds months", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 2)).toBe("2027-01");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(trendRange("2026-11")).toEqual({ from: "2025-12-01", to: "2026-11-30" });
    expect(ytdRange("2026-11")).toEqual({ from: "2026-01-01", to: "2026-11-30" });
  });
  it("computes the headline figures", () => {
    expect(headline({ incomeCents: 648000, spendingCents: 423000 })).toMatchObject({ netCents: 225000 });
    expect(headline({ incomeCents: 0, spendingCents: 500 })).toMatchObject({ netCents: -500, savingsRate: null });
  });
});

describe("monthly pdf", () => {
  it("is a one-page PDF that draws the figures", async () => {
    const data = {
      scope: "all",
      month: "2026-11",
      range: monthRange("2026-11"),
      flow: {
        nodes: [],
        links: [
          { source: "income:a", target: "income", cents: 100000, rowIds: [id(1)] },
          { source: "income", target: "expense:b", cents: 40000, rowIds: [id(2)] },
          { source: "income", target: "savings", cents: 60000, rowIds: [] },
        ],
        incomeCents: 100000,
        drawnCents: 0,
        spendingCents: 40000,
        savingsCents: 60000,
        rowIds: [id(1), id(2)],
      },
      spending: { rows: [], totalCents: 40000, refundCents: 0, rowIds: [] },
      payers: { range: ytdRange("2026-11"), rows: [{ payer: "Wordwise ✓", cents: 100000, count: 1, share: 1, rowIds: [id(1)] }], totalCents: 100000, rowIds: [id(1)] },
      trend: { range: trendRange("2026-11"), months: [], rowIds: [] },
    } as unknown as ReportsData;
    const bytes = await monthlyPdf(data);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const raw = Buffer.from(bytes).toString("latin1");
    const text = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"))
      .flatMap((c) => [...c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((t) => Buffer.from(t[1]!, "hex").toString("latin1")));
    expect(text).toEqual(expect.arrayContaining(["$600.00", "$1,000.00", "$400.00", "60.0%", "Monthly report"]));
    expect(text.some((t) => t.startsWith("November 2026"))).toBe(true);
    expect(text).toContain("Wordwise ?"); // a character outside Latin-1 prints as "?", it does not fail the file

    // An added business prints by its name, not its slug.
    const named = Buffer.from(await monthlyPdf({ ...data, scope: "north-partners" }, "North Partners")).toString("latin1");
    const header = [...named.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"))
      .flatMap((c) => [...c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((t) => Buffer.from(t[1]!, "hex").toString("latin1")))
      .find((t) => t.startsWith("November 2026"));
    expect(header).toContain("North Partners");
    expect(header).not.toContain("north-partners");
  });

  it("counts refunds apart from income: its own Refunds line, never an income source", async () => {
    const flow = {
      nodes: [
        { id: "income:a", label: "Brand deals", column: 0, cents: 100000 },
        { id: "refunds", label: "Refunds", column: 0, cents: 2500 },
      ],
      links: [
        { source: "refunds", target: "income", cents: 2500, rowIds: [id(3), id(4)] },
        { source: "income:a", target: "income", cents: 100000, rowIds: [id(1)] },
        { source: "drawn", target: "income", cents: 0, rowIds: [] },
        { source: "income", target: "expense:b", cents: 102500, rowIds: [id(2)] },
      ],
      incomeCents: 100000,
      drawnCents: 0,
      spendingCents: 40000,
      savingsCents: 0,
      rowIds: [id(1), id(2), id(3), id(4)],
    };
    expect(incomeSources(flow).map((l) => l.source)).toEqual(["income:a"]);
    const data = {
      scope: "all",
      month: "2026-11",
      range: monthRange("2026-11"),
      flow,
      spending: { rows: [], totalCents: 40000, refundCents: 2500, rowIds: [] },
      payers: { range: ytdRange("2026-11"), rows: [], totalCents: 0, rowIds: [] },
      trend: { range: trendRange("2026-11"), months: [], rowIds: [] },
    } as unknown as ReportsData;
    const raw = Buffer.from(await monthlyPdf(data)).toString("latin1");
    const text = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"))
      .flatMap((c) => [...c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((t) => Buffer.from(t[1]!, "hex").toString("latin1")));
    expect(text.filter((t) => t === "Refunds")).toHaveLength(1);
    const at = text.indexOf("Refunds");
    expect(text.slice(at, at + 3)).toEqual(["Refunds", "2", "$25.00"]);
    expect(text.indexOf("Brand deals")).toBeLessThan(at); // after the sources, not one of them
  });
});
