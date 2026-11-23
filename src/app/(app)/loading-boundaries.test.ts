import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

/*
 * A loading.tsx at the (app) group root is the fallback for every child segment, so the Dashboard skeleton
 * could show on a navigation between any two pages. Each page owns its loading boundary; the group root has none.
 */
const APP = path.join(process.cwd(), "src/app/(app)");

function pageDirs(dir: string): string[] {
  const here = existsSync(path.join(dir, "page.tsx")) ? [dir] : [];
  return here.concat(
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => pageDirs(path.join(dir, e.name))),
  );
}

test("the (app) group root has no loading boundary", () => {
  expect(existsSync(path.join(APP, "loading.tsx"))).toBe(false);
  expect(existsSync(path.join(APP, "layout.tsx"))).toBe(true);
  expect(existsSync(path.join(APP, "template.tsx"))).toBe(true);
});

test("the Dashboard and its skeleton live in their own (home) group", () => {
  expect(existsSync(path.join(APP, "(home)/page.tsx"))).toBe(true);
  expect(existsSync(path.join(APP, "(home)/loading.tsx"))).toBe(true);
});

test("every page sits next to its own loading.tsx", () => {
  const dirs = pageDirs(APP);
  expect(dirs.map((d) => path.relative(APP, d)).sort()).toEqual(
    ["(home)", "accounts", "activity", "brand", "notes", "planning", "reports", "routines", "settings", "taxes", "transactions", "ugc"],
  );
  for (const dir of dirs) expect(existsSync(path.join(dir, "loading.tsx")), path.relative(APP, dir)).toBe(true);
});
