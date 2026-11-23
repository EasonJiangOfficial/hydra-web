import { notFound } from "next/navigation";
import type { ReactNode } from "react";

/** Fixture pages (/dev/*) hold no real data. They exist in development and in the e2e build only. */
export default function DevLayout({ children }: { children: ReactNode }) {
  const enabled = process.env.NODE_ENV !== "production" || process.env.HYDRA_DEV_ROUTES === "1";
  if (!enabled) notFound();
  return children;
}
