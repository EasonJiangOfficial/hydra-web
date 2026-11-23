import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

/** Fixture: the app shell with the Dashboard stub, outside the login wall. */
export default function ShellFixture() {
  return (
    <AppShell activeHref="/">
      <div className="flex flex-col gap-5">
        <PageHeader />
      </div>
    </AppShell>
  );
}
