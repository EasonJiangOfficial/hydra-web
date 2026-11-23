import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * Hydra button (DESIGN.md section 7): 34 px, 8 px corners, presses to 0.98.
 * `primary` is the one filled button per page; `outline` has a rule-2 border; `ghost` is plain 500 text.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border text-body whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,transform] duration-200 ease-out active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "border-ink bg-ink font-medium text-white hover:border-black hover:bg-black",
        outline: "border-rule-2 bg-transparent font-normal text-ink hover:bg-tint",
        ghost: "border-transparent bg-transparent font-medium text-ink hover:bg-tint",
      },
      size: {
        default: "h-[34px] px-3.5",
        icon: "size-[34px]",
        "icon-sm": "size-7 rounded-md",
      },
    },
    compoundVariants: [{ variant: "ghost", size: "default", className: "px-2.5" }],
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "outline",
  size = "default",
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
