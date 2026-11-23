import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { LOADING, type LoadingKey } from "@/components/shell/skeletons";

export function generateStaticParams() {
  return Object.keys(LOADING).map((page) => ({ page }));
}

/** Fixture: each route's loading skeleton inside the shell. */
export default async function LoadingFixture({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!Object.hasOwn(LOADING, page)) notFound();
  const { href, Component } = LOADING[page as LoadingKey];
  return (
    <AppShell activeHref={href}>
      <Component />
    </AppShell>
  );
}
