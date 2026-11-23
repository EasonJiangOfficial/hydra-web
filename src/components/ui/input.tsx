import * as React from "react"
import { cn } from "@/lib/utils"

/** Hydra input: 34 px, rule-2 border, 8 px corners, the border turns ink on focus. Invalid is an ink border too: the error text carries the meaning; red is only for money lost or overdue. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[34px] w-full min-w-0 rounded-lg border border-rule-2 bg-surface px-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-ink",
        className
      )}
      {...props}
    />
  )
}

export { Input }
