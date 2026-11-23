/**
 * A page that must ask before the app leaves it in code (Notes while an edit is unsent). Links and Back are
 * the page's own to catch; navigation started in code (the agent's router.push) asks here first.
 */
type Guard = (href: string) => boolean;
let guard: Guard | null = null;

/** The page asks before a navigation in code: `fn` returns false to keep the page (and asks the owner itself). Returns the unguard. */
export function guardLeave(fn: Guard): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/** True to go on to `href`; false when the page kept the owner there to ask. */
export function mayLeave(href: string): boolean {
  return guard ? guard(href) : true;
}
