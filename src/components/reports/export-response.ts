import { buildExport } from "./exports";
import { isExportKind, isMonth, type ExportInput } from "./model";
import { SLUG_RE } from "@/lib/entities/model";
import type { ReportScope } from "@/lib/reports/queries";

/** Parses `?kind=&scope=&month=`, loads the numbers and answers with the file. Both download routes use it. */
export async function exportResponse(search: URLSearchParams, load: (scope: ReportScope, month: string) => Promise<ExportInput>) {
  const kind = search.get("kind");
  const scope = search.get("scope") ?? "all";
  const month = search.get("month");
  if (!isExportKind(kind) || !(scope === "all" || SLUG_RE.test(scope)) || !isMonth(month)) return new Response("Bad download request", { status: 400 });
  const file = await buildExport(kind, await load(scope as ReportScope, month));
  return new Response(file.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
