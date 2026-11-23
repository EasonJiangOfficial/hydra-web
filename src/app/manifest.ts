import type { MetadataRoute } from "next";

/** Served at /manifest.webmanifest. Icons are rendered from design/logo/hydra-app-icon.svg. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hydra",
    short_name: "Hydra",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#FFFFFF",
    background_color: "#FFFFFF",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
