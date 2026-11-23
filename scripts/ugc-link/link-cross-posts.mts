/**
 * One-time cross-post backfill (DESIGN.md section 8). Links each deal's unlinked posts that are
 * the same video on another platform (src/lib/ugc/match.ts), so the ledger pays them once.
 *
 *   node scripts/ugc-link/link-cross-posts.mts --db-url <postgres url> [--deal <uuid>] [--write]
 *
 * Without --write it is a dry run: per deal it prints posts, videos before -> after, posts linked,
 * and what the deal earned before -> after, priced by the real ledger (src/lib/ugc/ledger.ts) on
 * the database's rows (split into same-rate and mixed-rate videos: a group pays at its most-viewed
 * post's rate), then the groups it would make or grow (+ = moves, = = already there), then the
 * posts HELD because their twin's group has an excluded member or a $0 override (link by hand).
 * --write writes the same links in one transaction and fails, writing nothing, if any row changed
 * since it read. It only ever sets video_group_id on posts that have none (or sit alone in an
 * `auto-` group a race left) and that the owner did not set by hand (video_group_manual, 0116). Run it as the database owner (psql). A rerun links
 * nothing new.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve "@/x" to src/x.ts the way the app does, so the real ledger runs here.
const SRC = new URL("../../src/", import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const file = new URL(`${specifier.slice(2)}.ts`, SRC).href;
      if (existsSync(fileURLToPath(file))) return next(file, context);
    }
    return next(specifier, context);
  },
});

type Plan = typeof import("@/lib/ugc/cross-post-plan");
type Days = typeof import("@/lib/ugc/days");
type DealRow = import("@/lib/ugc/ledger").DealRow;
type PlanPost = import("@/lib/ugc/cross-post-plan").PlanPost;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function args(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbUrl = get("--db-url");
  const deal = get("--deal");
  if (!dbUrl) throw new Error("--db-url <postgres url> is required");
  if (deal !== undefined && !UUID.test(deal)) throw new Error("--deal must be a uuid");
  return { dbUrl, deal, write: argv.includes("--write") };
}

function psql(dbUrl: string, sql: string): string {
  return execFileSync("psql", [dbUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
}

const POST_FIELDS =
  "p.id, p.deal_id, p.platform, p.title, p.posted_at, p.video_group_id, p.video_group_manual, p.exclude_from_pay, " +
  "p.manual_override_cents, p.base_pay_cents_snap, p.base_min_views_snap, p.view_bonuses_snap, p.view_bonus_mode_snap, " +
  "p.cpm_rate_snap, p.cpm_view_unit_snap, p.cpm_cap_views_snap, p.cpm_min_views_snap, p.cpm_tiers_snap, p.cpm_mode_snap, " +
  "p.cpm_tier_mode_snap, v.payable_views";

export function readSql(deal?: string): string {
  const where = deal ? `where d.id = '${deal}'` : "";
  return `select json_build_object(
  'zone', (select time_zone from public.settings limit 1),
  'deals', coalesce((select json_agg(d order by d.id) from public.deals d ${where}), '[]'::json),
  'posts', coalesce((select json_agg(x order by x.id) from (
    select ${POST_FIELDS} from public.posts p
    join public.deals d on d.id = p.deal_id
    left join public.ugc_post_views v on v.post_id = p.id ${where}) x), '[]'::json));`;
}

async function main() {
  const { dbUrl, deal, write } = args(process.argv.slice(2));
  const plan: Plan = await import(new URL("../../src/lib/ugc/cross-post-plan.ts", import.meta.url).href);
  const days: Days = await import(new URL("../../src/lib/ugc/days.ts", import.meta.url).href);
  const snap = JSON.parse(psql(dbUrl, readSql(deal))) as { zone: string | null; deals: DealRow[]; posts: PlanPost[] };
  const zone = days.ownerZone(snap.zone);
  const today = days.dayKeyInZone(new Date(), zone);
  const plans = plan.planCrossPosts(snap.deals, snap.posts, zone, today);
  console.log(`Zone ${zone}, today ${today}. ${write ? "WRITE" : "Dry run (add --write to link)"}.`);
  console.log(plan.formatPlan(plans));
  const links = plans.flatMap((p) => p.links);
  if (!write) return;
  if (links.length === 0) {
    console.log("Nothing to link.");
    return;
  }
  psql(dbUrl, plan.writeSql(links));
  console.log(`Wrote ${links.length} links in one transaction.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
