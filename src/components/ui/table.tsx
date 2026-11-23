import * as React from "react"
import { cn } from "@/lib/utils"

/* Hydra tables: hairlines only. th 12 px ink-3 400 at 8/12 padding; td 12 padding;
   `numeric` cells are right-aligned tabular figures; `clickable` rows tint on hover. */

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full border-collapse text-body", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" {...props} />
}

function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("font-medium", className)} {...props} />
}

function TableRow({
  className,
  clickable,
  ...props
}: React.ComponentProps<"tr"> & { clickable?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        clickable && "cursor-pointer [&>td]:transition-colors [&>td]:duration-200 hover:[&>td]:bg-tint",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  numeric,
  ...props
}: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "border-b border-rule px-3 py-2 text-left align-middle text-tag font-normal whitespace-nowrap text-ink-3",
        numeric && "text-right",
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  numeric,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "border-b border-rule p-3 align-middle",
        numeric && "text-right whitespace-nowrap tabular-nums",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("sr-only", className)} {...props} />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
