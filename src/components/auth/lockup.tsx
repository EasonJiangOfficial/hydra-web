/* The logo, from design/logo/hydra-lockup.svg (DESIGN.md section 7): three linked rings, then
   "Hydra" in the system sans at 400. x = cap height of the word; the mark is 1.5x tall and
   centered on the capitals; the gap is 0.5x. CSS `cap` units make that exact for any font. */

export function HydraMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 69.47 66" aria-hidden="true" className={className}>
      <g fill="none" stroke="currentColor" strokeWidth="5">
        <circle cx="34.74" cy="21.71" r="19.21" />
        <circle cx="21.71" cy="44.29" r="19.21" />
        <circle cx="47.76" cy="44.29" r="19.21" />
      </g>
    </svg>
  );
}

export function Lockup({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Hydra"
      data-testid="lockup"
      className={`inline-flex items-baseline gap-[0.5cap] text-title font-normal tracking-[-0.019em] text-ink ${className}`}
    >
      {/* Bottom of the mark sits 0.25x under the baseline, so its center is on the capitals. */}
      <HydraMark className="relative top-[0.25cap] h-[1.5cap] w-auto shrink-0" />
      <span aria-hidden="true">Hydra</span>
    </span>
  );
}
