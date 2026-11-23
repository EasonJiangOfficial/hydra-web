"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * What an error boundary shows (src/app/error.tsx, (app)/error.tsx, global-error.tsx), in DESIGN.md section 7:
 * a title, one filled button, a plain one. No explanation on the page.
 */
export function ErrorScreen({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main data-testid="error-screen" className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className="text-[22px] font-medium tracking-[-0.01em] text-ink">This page didn&rsquo;t load</h1>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => retry()}>
          Try again
        </Button>
        <Button variant="ghost" onClick={() => history.back()}>
          Back
        </Button>
      </div>
    </main>
  );
}
