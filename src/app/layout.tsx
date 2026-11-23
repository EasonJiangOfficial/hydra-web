import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "@/components/pwa/register-sw";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Hydra", template: "%s · Hydra" },
  robots: { index: false, follow: false },
  // iOS reads the apple-touch-icon link for Add to Home Screen; the manifest link comes from manifest.ts.
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-canvas text-ink">
        <TooltipProvider delayDuration={80}>{children}</TooltipProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
