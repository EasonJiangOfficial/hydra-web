import { connection, type NextRequest } from "next/server";
import { exportResponse } from "@/components/reports/export-response";
import { createServerClient } from "@/lib/supabase/server";
import { loadExport } from "../load";

/** Report downloads: `?kind=monthly-pdf|transactions-csv|payers-csv|tax-pack&scope=&month=YYYY-MM`. Owner only. */
export async function GET(req: NextRequest) {
  await connection(); // per request: never prerendered at build
  const db = await createServerClient();
  const { data: owner } = await db.rpc("is_owner");
  if (owner !== true) return new Response("Sign in as the owner", { status: 401 });
  return exportResponse(req.nextUrl.searchParams, (scope, month) => loadExport(db, scope, month));
}
