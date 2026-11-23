/**
 * Drops emote tags the model writes for a voice that acts them out ("[wave] Goodnight, sir." -> "Goodnight, sir."):
 * any [word] or [two words], never a markdown link's [label](url). `partial` also drops a tag still being streamed at
 * the end ("Okay [wa"), for the last sentence of a reply.
 */
export function stripEmotes(text: string, partial = false): string {
  const out = text.replace(/\s*\[[a-z][a-z _'-]{0,30}\](?!\()/gi, "");
  return (partial ? out.replace(/\s*\[[a-z _'-]*$/i, "") : out).replace(/^\s+/, "");
}
