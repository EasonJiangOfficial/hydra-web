// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAmount, parseDate, parseImport, withImportHashes } from "./import";

const ACCOUNT = "bbbbbbbb-0000-4000-8000-000000000001";

const BOFA_CSV = [
  "Description,,Summary Amt.",
  'Beginning balance as of 11/01/2026,,"1,000.00"',
  "",
  "Date,Description,Amount,Running Bal.",
  '11/03/2026,"NETFLIX.COM, LOS GATOS",-15.49,984.51',
  '11/03/2026,"NETFLIX.COM, LOS GATOS",-15.49,969.02',
  '11/04/2026,"ACME ""PAYROLL"" PPD","$2,500.00","3,469.02"',
  '11/5/26,Refund (store),(12.34),3456.68',
  "13/45/2026,Bad date,1.00,",
  "11/06/2026,No amount,,",
].join("\r\n");

const DEBIT_CREDIT_CSV = ["Posting Date,Payee,Debit,Credit", "2026-11-01,Rent,1200.00,", "2026-11-02,Interest,,0.41"].join("\n");

const QFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261121120000<LANGUAGE>ENG<INTU.BID>3000</SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1<CCSTMTRS><CURDEF>USD<BANKTRANLIST>
<DTSTART>20261101<DTEND>20261121
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261103120000.000[-5:EST]
<TRNAMT>-42.10
<FITID>2026110301
<NAME>TRADER JOE&apos;S #123
<MEMO>GROCERIES
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261110
<TRNAMT>500.00
<FITID>2026111001
<NAME>PAYMENT THANK YOU
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-1234.56<DTASOF>20261121</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>POS</TRNTYPE><DTPOSTED>20261115</DTPOSTED><TRNAMT>-8.25</TRNAMT><FITID>X1</FITID><NAME>Blue Bottle &amp; Co</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>2048.00</BALAMT><DTASOF>20261120</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("parsing", () => {
  it("reads dates in ISO, US and OFX forms and refuses impossible ones", () => {
    expect(parseDate("2026-11-03")).toBe("2026-11-03");
    expect(parseDate("11/3/2026")).toBe("2026-11-03");
    expect(parseDate("1/9/26")).toBe("2026-01-09");
    expect(parseDate("20261103120000.000[-5:EST]")).toBe("2026-11-03");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("13/45/2026")).toBeNull();
    expect(parseDate("yesterday")).toBeNull();
  });

  it("reads amounts to exact cents", () => {
    expect(parseAmount("$1,234.56")).toBe(123456);
    expect(parseAmount("-0.29")).toBe(-29);
    expect(parseAmount("(12.34)")).toBe(-1234);
    expect(parseAmount("12.34-")).toBe(-1234);
    expect(parseAmount("−12.00")).toBe(-1200);
    expect(parseAmount("0.00")).toBe(0);
    expect(Object.is(parseAmount("-0.00"), -0)).toBe(false);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("finds the header under a bank's summary, keeps quoted commas and quotes, and reports bad rows", () => {
    const parsed = parseImport("csv", BOFA_CSV);
    expect(parsed.rows.map((r) => [r.row, r.postedOn, r.amountCents, r.name])).toEqual([
      [5, "2026-11-03", -1549, "NETFLIX.COM, LOS GATOS"],
      [6, "2026-11-03", -1549, "NETFLIX.COM, LOS GATOS"],
      [7, "2026-11-04", 250000, 'ACME "PAYROLL" PPD'],
      [8, "2026-11-05", -1234, "Refund (store)"],
    ]);
    expect(parsed.errors).toEqual([
      { row: 9, message: 'Bad date "13/45/2026"' },
      { row: 10, message: "Bad or missing amount" },
    ]);
  });

  it("reads debit and credit columns, and flips a card export with invertSign", () => {
    expect(parseImport("csv", DEBIT_CREDIT_CSV).rows.map((r) => r.amountCents)).toEqual([-120000, 41]);
    expect(parseImport("csv", DEBIT_CREDIT_CSV, { invertSign: true }).rows.map((r) => r.amountCents)).toEqual([120000, -41]);
  });

  it("refuses a CSV with no usable header", () => {
    expect(parseImport("csv", "a,b\n1,2").errors[0].message).toMatch(/No header row/);
  });

  it("reads QFX (SGML) transactions, FITIDs and the ledger balance", () => {
    const parsed = parseImport("qfx", QFX);
    expect(parsed.rows).toEqual([
      { row: 1, postedOn: "2026-11-03", amountCents: -4210, name: "TRADER JOE'S #123", rawDescription: "TRADER JOE'S #123 GROCERIES", fitid: "2026110301" },
      { row: 2, postedOn: "2026-11-10", amountCents: 50000, name: "PAYMENT THANK YOU", rawDescription: "PAYMENT THANK YOU", fitid: "2026111001" },
    ]);
    expect(parsed.balance).toEqual({ asOf: "2026-11-21", amountCents: -123456 });
    expect(parsed.errors).toEqual([]);
  });

  it("reads OFX 2 (XML)", () => {
    const parsed = parseImport("ofx", OFX_XML);
    expect(parsed.rows).toEqual([{ row: 1, postedOn: "2026-11-15", amountCents: -825, name: "Blue Bottle & Co", rawDescription: "Blue Bottle & Co", fitid: "X1" }]);
    expect(parsed.balance).toEqual({ asOf: "2026-11-20", amountCents: 204800 });
  });
});

describe("duplicate skip", () => {
  const hashes = (text: string, account = ACCOUNT) => withImportHashes(account, parseImport("csv", text).rows).map((r) => r.hash);

  it("gives the same file the same hashes, so a re-import skips every row", () => {
    const first = new Set(hashes(BOFA_CSV));
    const again = hashes(BOFA_CSV);
    expect(again.filter((h) => !first.has(h))).toEqual([]);
    expect(first.size).toBe(4);
  });

  it("keeps two identical rows in one file as two rows", () => {
    const [a, b] = hashes(BOFA_CSV);
    expect(a).not.toBe(b);
  });

  it("skips only the rows an overlapping file already brought", () => {
    const existing = new Set(hashes(BOFA_CSV));
    const next = ["Date,Description,Amount", '11/04/2026,"ACME ""PAYROLL"" PPD","2,500.00"', "11/20/2026,GYM,-40.00"].join("\n");
    const fresh = hashes(next).filter((h) => !existing.has(h));
    expect(fresh).toHaveLength(1);
  });

  it("ignores case and spacing in the description, and depends on the account, date, amount and FITID", () => {
    const base = { row: 1, postedOn: "2026-11-03", amountCents: -1549, name: "x", rawDescription: "NETFLIX.COM  Los Gatos", fitid: null };
    const [h] = withImportHashes(ACCOUNT, [base]).map((r) => r.hash);
    const same = withImportHashes(ACCOUNT, [{ ...base, rawDescription: " netflix.com los gatos " }])[0].hash;
    expect(same).toBe(h);
    for (const changed of [{ postedOn: "2026-11-04" }, { amountCents: -1550 }, { fitid: "F1" }, { rawDescription: "Hulu" }]) {
      expect(withImportHashes(ACCOUNT, [{ ...base, ...changed }])[0].hash).not.toBe(h);
    }
    expect(withImportHashes("another-account", [base])[0].hash).not.toBe(h);
  });

  it("gives an OFX row with a FITID a stable hash", () => {
    const a = withImportHashes(ACCOUNT, parseImport("qfx", QFX).rows).map((r) => r.hash);
    const b = withImportHashes(ACCOUNT, parseImport("qfx", QFX).rows).map((r) => r.hash);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });
});
