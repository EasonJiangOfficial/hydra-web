/** The Instagram connection as the pages show it (Personal Brand header, Settings > Connections). Client-safe; never the token. */
export interface InstagramView {
  /** Which of META_APP_ID, META_APP_SECRET, INSTAGRAM_CONFIG_ID and HYDRA_TOKEN_KEY the host still needs. Empty: Connect can start. */
  missing: string[];
  /** The connected account's username, or null when not connected. */
  username: string | null;
  lastSyncedAt: string | null;
  /**
   * The last sync's error class: reauth_required, rate_limited, instagram_error, internal; or what a finished sync
   * missed, a comma-separated set of insights_partial, insights_refused, insights_not_granted, media_cut.
   */
  lastError: string | null;
}

export type InstagramState = "off" | "none" | "connected" | "reconnect";

export function instagramState(v: InstagramView): InstagramState {
  if (!v.username) return v.missing.length === 0 ? "none" : "off";
  return v.lastError === "reauth_required" ? "reconnect" : "connected";
}

/** Why Connect is off (shown in an InfoDot): only the variables the host still needs. */
export function instagramEnvNote(missing: string[]): string {
  const names = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : (missing[0] ?? "");
  return `Instagram is not set up yet. Add ${names} on the host.`;
}

/** last_error as its parts: one error class, or a finished sync's notes. */
export const instagramNotes = (lastError: string | null): string[] => (lastError ? lastError.split(",").filter(Boolean) : []);

/** Insights not granted, or every post's refused for a permission: Settings offers Reconnect, quietly (the sync still runs). */
export const instagramNeedsGrant = (v: InstagramView) => instagramNotes(v.lastError).some((k) => k === "insights_not_granted" || k === "insights_refused");

/** last_error as words, every part named. Null when there is none. */
export function instagramErrorNote(lastError: string | null): string | null {
  return instagramNotes(lastError).map((k) => INSTAGRAM_ERROR[k] ?? INSTAGRAM_ERROR.internal).join(" ") || null;
}

/** A sync error class as words. */
export const INSTAGRAM_ERROR: Record<string, string> = {
  reauth_required: "Instagram signed Hydra out. Reconnect.",
  rate_limited: "Instagram asked Hydra to slow down.",
  instagram_error: "Instagram refused the last sync.",
  internal: "The last sync failed.",
  insights_partial: "Instagram refused views for some posts.",
  insights_refused: "Instagram refused views for every post. If this lasts, Reconnect in Settings.",
  insights_not_granted: "Instagram did not share views. Reconnect in Settings to allow them.",
  media_cut: "The last sync stopped at 500 posts; older ones were left out.",
};

/** Where /api/instagram/callback sent the owner back (?instagram=). */
export const INSTAGRAM_SIGN_IN: Record<string, string> = {
  denied: "Instagram sign-in was cancelled.",
  error: "Instagram sign-in failed. Try again.",
  not_configured: "Instagram is not set up on the host yet.",
};
