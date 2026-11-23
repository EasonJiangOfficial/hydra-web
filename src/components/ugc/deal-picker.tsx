"use client";

import { Check, ChevronDown, Ellipsis, Layers } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { cn } from "@/components/kit";

import { DealLogo, ErrorText, useAct } from "./controls";
import { isArchived, type DealView } from "./model";
import { useUgc } from "./store";

const LAYER =
  "z-50 rounded-lg border border-rule bg-surface p-1 text-ink outline-none duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1";

/** The small ink label a "..." button shows on hover (mouse only: Tailwind's hover: skips touch). */
function HoverLabel({ children }: { children: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-1/2 right-full mr-1 -translate-y-1/2 rounded-md bg-ink px-1.5 py-0.5 text-micro whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/more:opacity-100 group-hover/more:delay-[80ms] group-data-[state=open]/more:opacity-0"
    >
      {children}
    </span>
  );
}

/** A row menu inside the deal picker's list: the list opens it from the keyboard and takes focus back. */
type InList = { open: boolean; onOpenChange: (open: boolean) => void; refocus: () => void };

/**
 * The "..." menu of one deal: Archive (no target days after today) or Restore, and Delete, which asks first
 * with the deal's name. Lives on each deal's day card and on each row of the deal picker (`list`).
 */
export function DealMenu({ view, className, inList }: { view: DealView; className?: string; inList?: InList }) {
  const { actions } = useUgc();
  const { busy, error, act, clear } = useAct();
  const [own, setOwn] = useState(false);
  const open = inList ? inList.open : own;
  const [asking, setAsking] = useState(false);
  const { deal } = view;
  const name = deal.brand_name;
  const videos = view.earnings.videos.length;
  const item =
    "flex h-8 cursor-default items-center rounded-md px-2 text-body outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-tint";
  const toggle = (o: boolean) => {
    (inList ? inList.onOpenChange : setOwn)(o);
    if (!o) {
      setAsking(false);
      clear();
    }
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={toggle} modal={false}>
      <DropdownMenu.Trigger
        aria-label={`More for ${name}`}
        data-deal-menu={deal.id}
        // In the list the row's option is the keyboard stop (ArrowRight opens this menu), not the button.
        {...(inList && { tabIndex: -1, "aria-hidden": true })}
        className={cn(
          "group/more relative grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-200 outline-none hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=open]:bg-surface data-[state=open]:text-ink",
          className,
        )}
      >
        <Ellipsis aria-hidden strokeWidth={1.5} className="size-4" />
        <HoverLabel>More</HoverLabel>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onCloseAutoFocus={
            inList &&
            ((e) => {
              e.preventDefault();
              inList.refocus();
            })
          }
          className={cn(LAYER, "w-56")}
        >
          {asking ? (
            <>
              <p className="px-2 pt-1.5 pb-2 text-label text-ink-2">
                {`Delete ${name} with its ${videos} ${videos === 1 ? "video" : "videos"}, readings and payments?`}
              </p>
              <DropdownMenu.Item className={item} disabled={busy} onSelect={(e) => (e.preventDefault(), setAsking(false))}>
                Cancel
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={cn(item, "font-medium")}
                disabled={busy}
                onSelect={async (e) => {
                  e.preventDefault();
                  let activityId: string | null | undefined;
                  const ok = await act(async () => {
                    const r = await actions.deleteDeal({ id: deal.id });
                    if (r.ok) activityId = r.activityId;
                    return r;
                  });
                  if (ok) {
                    toggle(false);
                    offerUndo(activityId, `deal "${name}"`);
                  }
                }}
              >
                Delete
              </DropdownMenu.Item>
            </>
          ) : (
            <>
              {isArchived(deal) ? (
                <DropdownMenu.Item
                  className={item}
                  disabled={busy}
                  onSelect={async (e) => {
                    e.preventDefault();
                    if (await act(() => actions.resumeDeal({ id: deal.id }))) toggle(false);
                  }}
                >
                  Restore
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  className={item}
                  disabled={busy}
                  onSelect={async (e) => {
                    e.preventDefault();
                    if (await act(() => actions.endDeal({ id: deal.id }))) toggle(false);
                  }}
                >
                  Archive
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item className={item} disabled={busy} onSelect={(e) => (e.preventDefault(), setAsking(true))}>
                Delete
              </DropdownMenu.Item>
            </>
          )}
          {error && (
            <div className="px-2 pb-1.5">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The 20 px mark in front of "All deals", the same size as a logo. */
function AllMark() {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-md border border-rule bg-surface text-ink-3">
      <Layers strokeWidth={1.5} className="size-3" />
    </span>
  );
}

type Option = { id: string | null; name: string; view: DealView | null };

/**
 * The deal picker: a button showing the brand's logo and name, opening a list of deals with theirs.
 * Keyboard: arrows, Home/End, Enter or Space picks, typing jumps to a brand (a space inside a name counts),
 * ArrowRight or Shift+F10 opens the active row's "..." menu, Escape closes.
 * Archived deals stay out of the list until "Show archived" at its foot. `allLabel` adds an "all deals" row
 * (value null); `menus` puts each deal's "..." menu on its row.
 */
export function DealPicker({
  deals,
  value,
  onChange,
  allLabel,
  menus = false,
  id,
  "aria-label": label,
  className,
}: {
  deals: readonly DealView[];
  value: string | null;
  onChange: (id: string | null) => void;
  allLabel?: string;
  menus?: boolean;
  id?: string;
  "aria-label": string;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const picked = deals.find((d) => d.deal.id === value) ?? null;
  const [showArchived, setShowArchived] = useState(() => (picked ? isArchived(picked.deal) : false));
  const [active, setActive] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const archivedCount = deals.filter((d) => isArchived(d.deal)).length;
  const options: Option[] = [
    ...(allLabel ? [{ id: null, name: allLabel, view: null }] : []),
    ...deals.filter((d) => showArchived || !isArchived(d.deal)).map((d) => ({ id: d.deal.id, name: d.deal.brand_name, view: d })),
  ];
  const selectedIndex = Math.max(0, options.findIndex((o) => o.id === value));
  const at = Math.min(active, options.length - 1);
  const optionId = (i: number) => `${listId}-o${i}`;

  const show = (o: boolean) => {
    if (o) setActive(selectedIndex);
    setMenuFor(null);
    typed.current = { text: "", at: 0 };
    setOpen(o);
  };
  const pick = (o: Option | undefined) => {
    if (!o) return;
    onChange(o.id);
    setOpen(false);
  };
  const move = (i: number) => {
    const next = Math.max(0, Math.min(options.length - 1, i));
    setActive(next);
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  };

  const onListKey = (e: KeyboardEvent) => {
    // Keys pressed in a row's "..." menu bubble here through React's tree (the menu is portaled): they are the menu's.
    if (e.target !== e.currentTarget) return;
    const typing = typed.current.text !== "" && e.timeStamp - typed.current.at < 600;
    const row = options[at];
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(options.length - 1);
    else if (e.key === "Enter" || (e.key === " " && !typing)) pick(row);
    else if (e.key === "ArrowRight" || (e.key === "F10" && e.shiftKey)) {
      if (!menus || !row?.view) return;
      setMenuFor(row.id);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: letters typed within 600 ms build one prefix.
      const now = e.timeStamp;
      const text = (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase();
      typed.current = { text, at: now };
      const hit = options.findIndex((o) => o.name.toLowerCase().startsWith(text));
      if (hit >= 0) move(hit);
    } else return;
    e.preventDefault();
  };

  return (
    <Popover.Root open={open} onOpenChange={show}>
      <Popover.Trigger
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        data-deal-picker=""
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show(true);
          }
        }}
        className={cn(
          "relative flex h-[34px] min-w-0 items-center gap-2 rounded-lg border border-rule-2 bg-surface pr-8 pl-2 text-left text-body text-ink transition-colors duration-200 outline-none hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink data-[state=open]:border-ink",
          className,
        )}
      >
        {picked ? <DealLogo name={picked.deal.brand_name} url={picked.logoUrl} size={20} /> : <AllMark />}
        <span className="min-w-0 flex-1 truncate">{picked ? picked.deal.brand_name : (allLabel ?? "Pick a deal")}</span>
        {picked && isArchived(picked.deal) && <span className="text-tag text-ink-3">Archived</span>}
        <ChevronDown
          aria-hidden
          strokeWidth={1.5}
          className={cn("pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-3 transition-transform duration-200", open && "rotate-180")}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={16}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            listRef.current?.focus();
          }}
          className={cn(LAYER, "flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[max(var(--radix-popover-trigger-width),240px)] flex-col")}
        >
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={0}
            aria-label={label}
            aria-activedescendant={options.length ? optionId(at) : undefined}
            onKeyDown={onListKey}
            className="group/list min-h-0 flex-1 overflow-y-auto outline-none"
          >
            {options.map((o, i) => {
              const selected = o.id === value;
              const archived = o.view ? isArchived(o.view.deal) : false;
              return (
                <div
                  key={o.id ?? "all"}
                  role="none"
                  data-active={i === at}
                  onPointerMove={() => i !== at && setActive(i)}
                  className="flex items-center gap-1 rounded-md pr-1 transition-colors duration-150 data-[active=true]:bg-tint group-focus-visible/list:data-[active=true]:outline-2 group-focus-visible/list:data-[active=true]:-outline-offset-2 group-focus-visible/list:data-[active=true]:outline-ink"
                >
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    data-deal-option={o.id ?? "all"}
                    onClick={() => pick(o)}
                    className="flex h-9 min-w-0 flex-1 cursor-default items-center gap-2.5 pl-2 select-none"
                  >
                    {o.view ? <DealLogo name={o.name} url={o.view.logoUrl} size={20} /> : <AllMark />}
                    <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>{o.name}</span>
                    {archived && <span className="text-tag text-ink-3">Archived</span>}
                    <Check aria-hidden strokeWidth={1.75} className={cn("size-4 shrink-0", selected ? "text-ink" : "invisible")} />
                  </div>
                  {menus && o.view && (
                    <DealMenu
                      view={o.view}
                      inList={{
                        open: menuFor === o.id,
                        onOpenChange: (v) => setMenuFor(v ? o.id : null),
                        refocus: () => listRef.current?.focus(),
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {archivedCount > 0 && (
            <div className="-mx-1 mt-1 shrink-0 border-t border-rule px-1 pt-1">
              <button
                type="button"
                aria-pressed={showArchived}
                onClick={() => {
                  setShowArchived((v) => !v);
                  listRef.current?.focus();
                }}
                className="flex h-8 w-full items-center rounded-md px-2 text-left text-tag text-ink-3 transition-colors duration-200 outline-none hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
              >
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
