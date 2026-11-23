import { connection, type NextRequest } from "next/server";
import { exportResponse } from "@/components/reports/export-response";
import { fixtureDb, fixtureExport } from "../fixture-db";

/** Fixture downloads, the same four files as /reports/export, built from the in-memory books. Dev and e2e builds only. */
export async function GET(req: NextRequest) {
  await connection(); // per request: never prerendered at build
  // Route handlers do not sit under src/app/dev/layout.tsx, so the same gate lives here.
  if (process.env.NODE_ENV === "production" && process.env.HYDRA_DEV_ROUTES !== "1") return new Response("Not found", { status: 404 });
  return exportResponse(req.nextUrl.searchParams, (scope, month) => fixtureExport(fixtureDb(), scope, month));
}
