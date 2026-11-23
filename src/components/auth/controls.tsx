import type { ComponentProps } from "react";

/* Login and lock controls, styled locally per DESIGN.md section 7: 34 px tall, 8 px radius,
   one filled ink button per screen, plain text for the rest. Plain class strings on purpose:
   `cn` drops `text-label` when it is next to a `text-ink-*` color. */

const press = "transition-[transform,opacity] duration-200 ease-out active:scale-[0.98] motion-reduce:active:scale-100";
const focus = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function FilledButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      data-filled=""
      className={`inline-flex h-[34px] w-full items-center justify-center rounded-lg bg-ink px-4 text-body font-medium text-white hover:opacity-90 disabled:opacity-50 ${press} ${focus} ${className}`}
      {...props}
    />
  );
}

export function PlainButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      className={`inline-flex h-[34px] items-center justify-center rounded-lg px-2 text-label text-ink-3 transition-colors duration-200 hover:text-ink disabled:opacity-50 ${focus} ${className}`}
      {...props}
    />
  );
}

export function Field({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      className={`h-[34px] w-full rounded-lg border border-rule-2 bg-canvas px-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink ${className}`}
      {...props}
    />
  );
}

export function ErrorText({ children }: { children: string | null }) {
  return (
    <p role="alert" aria-live="polite" className="min-h-[17px] text-label text-ink-2">
      {children}
    </p>
  );
}
