"use client";

import { ErrorScreen } from "@/components/error-screen";
import "./globals.css";

/** The root layout itself failed: the same screen, in its own document (global-error replaces the root layout). */
export default function GlobalError(props: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
