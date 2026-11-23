import { IdleLock } from "@/components/auth/idle-lock";
import { FixtureSheet } from "./sheet";

/**
 * Fixture: the idle lock over placeholder content, 1-minute limit, plus a portaled sheet.
 * Its own storage prefix, so it never locks the real app on the same origin. No real data.
 */
export default function AuthLockFixture() {
  return (
    <IdleLock minutes={1} storagePrefix="hydra-dev-lock">
      <main className="mx-auto max-w-[960px] p-6">
        <h1 className="text-title">Fixture content</h1>
        <p data-testid="fixture-content" className="mt-2 text-body text-ink-2">
          Net worth $123,456.78
        </p>
        <FixtureSheet />
      </main>
    </IdleLock>
  );
}
