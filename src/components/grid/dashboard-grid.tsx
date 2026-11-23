"use client";

import { GripVertical, X } from "lucide-react";
import ReactGridLayout, { useContainerWidth, verticalCompactor } from "react-grid-layout";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button, Card, Label, cn } from "@/components/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  BREAKPOINTS,
  GRID,
  applyGrid,
  defaultItems,
  hideItem,
  normalizeItems,
  fitItems,
  sameItems,
  showItem,
  visibleItems,
  type Breakpoint,
  type Fit,
  type Item,
} from "@/lib/layout/model";
import type { LayoutRow, ResetResult, SaveInput, SaveResult } from "@/lib/layout/store";
import type { BlockDef } from "./registry";
import "./grid.css";

/** Where layouts are saved. `saveLayout` and `resetLayout` from `@/lib/layout/actions` fit as they are. */
export type Persistence = {
  save: (input: SaveInput) => Promise<SaveResult>;
  reset: (input: { breakpoint: Breakpoint }) => Promise<ResetResult>;
};

export type SavedLayouts = Partial<Record<Breakpoint, LayoutRow | null>>;

export type DashboardGridProps = {
  registry: readonly BlockDef[];
  /** What `loadLayouts()` returned. Anything missing, unknown or out of range is repaired. */
  initial?: SavedLayouts;
  persistence?: Persistence;
  /** Ready-made content per block id (server-rendered cards); wins over the registry component. */
  content?: Partial<Record<string, ReactNode>>;
  /** Top bar, left side (the date). */
  lead?: ReactNode;
  /** Top bar, right side, before the edit controls (the scope switch). */
  trail?: ReactNode;
  /** Id of a phone header element: outside edit mode Edit sits there and the empty bar row goes away. */
  phoneEditSlot?: string;
  /** Milliseconds a change waits before it is saved. */
  saveDelay?: number;
  /**
   * What the data asks of a block outside edit mode, per breakpoint: `false` leaves it out (nothing to show, so no
   * gap), a size draws it at that size. The saved layout never changes; Edit shows every block at its saved size.
   */
  fit?: (id: string, bp: Breakpoint) => Fit;
  /** The data is reloading (a scope switch): the blocks dim and say aria-busy until it lands. */
  reloading?: boolean;
  className?: string;
};

const DESKTOP_QUERY = "(min-width: 768px)";
const noopSubscribe = () => () => {};
function subscribe(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
/** null on the server and during hydration: the grid draws after it knows the width. */
function useBreakpoint(): Breakpoint | null {
  return useSyncExternalStore<Breakpoint | null>(
    subscribe,
    () => (window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "phone"),
    () => null,
  );
}

function build(registry: readonly BlockDef[], initial: SavedLayouts | undefined) {
  const items = {} as Record<Breakpoint, Item[]>;
  const tokens = {} as Record<Breakpoint, string | null>;
  for (const b of BREAKPOINTS) {
    const row = initial?.[b] ?? null;
    items[b] = row ? normalizeItems(row.items, registry, b) : defaultItems(registry, b);
    tokens[b] = row?.updatedAt ?? null;
  }
  return { items, tokens };
}

function BlockContent({ def, content }: { def: BlockDef; content?: ReactNode }) {
  if (content != null) return content;
  const Component: ComponentType | undefined = def.component;
  if (Component) return <Component />;
  return (
    <Card className="h-full">
      <Label>{def.title}</Label>
    </Card>
  );
}

const TILE =
  "grid place-items-center bg-surface text-ink-2 transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/**
 * The Dashboard's editable grid (DESIGN.md section 6 item 1). Outside edit mode nothing moves.
 * Edit turns on a drag handle, a resize corner and a remove x on every block, plus Add block,
 * Reset and Done. Desktop and phone each keep their own layout; changes save by themselves.
 */
export function DashboardGrid({
  registry,
  initial,
  persistence,
  content,
  lead,
  trail,
  phoneEditSlot,
  saveDelay = 600,
  fit,
  reloading = false,
  className,
}: DashboardGridProps) {
  const bp = useBreakpoint();
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const [boot] = useState(() => build(registry, initial));
  const [layouts, setLayouts] = useState(boot.items);
  const [editing, setEditing] = useState(false);
  // The slot is in the shell header, committed before this grid; null on the server and without a slot.
  const slot = useSyncExternalStore(
    noopSubscribe,
    () => (phoneEditSlot ? document.getElementById(phoneEditSlot) : null),
    () => null,
  );
  const itemsRef = useRef(boot.items);
  const tokens = useRef(boot.tokens);
  const dirty = useRef<Record<Breakpoint, boolean>>({ desktop: false, phone: false });
  const busy = useRef<Record<Breakpoint, boolean>>({ desktop: false, phone: false });
  const timers = useRef<Partial<Record<Breakpoint, ReturnType<typeof setTimeout>>>>({});
  const live = useRef({ persistence, saveDelay, registry });
  useEffect(() => {
    live.current = { persistence, saveDelay, registry };
  });

  const adopt = useCallback((b: Breakpoint, next: Item[]) => {
    itemsRef.current = { ...itemsRef.current, [b]: next };
    setLayouts(itemsRef.current);
  }, []);

  /** Save one breakpoint now. A save already running picks the newer changes up in its loop. */
  const flush = useCallback(
    async (b: Breakpoint) => {
      clearTimeout(timers.current[b]);
      const { persistence: store, registry: reg } = live.current;
      if (!store || busy.current[b]) return;
      busy.current[b] = true;
      try {
        while (dirty.current[b]) {
          dirty.current[b] = false;
          const r = await store.save({
            breakpoint: b,
            items: itemsRef.current[b],
            expectedUpdatedAt: tokens.current[b],
          });
          if (r.ok) {
            tokens.current[b] = r.updatedAt;
          } else if (r.reason === "conflict") {
            // Another tab saved first. Its layout wins; this tab reloads it.
            tokens.current[b] = r.current?.updatedAt ?? null;
            adopt(b, r.current ? normalizeItems(r.current.items, reg, b) : defaultItems(reg, b));
            break;
          } else {
            dirty.current[b] = true; // keep it; the next change or Done retries
            break;
          }
        }
      } catch {
        dirty.current[b] = true;
      } finally {
        busy.current[b] = false;
      }
    },
    [adopt],
  );

  const later = useCallback(
    (b: Breakpoint) => {
      clearTimeout(timers.current[b]);
      timers.current[b] = setTimeout(() => void flush(b), live.current.saveDelay);
    },
    [flush],
  );

  const commit = useCallback(
    (b: Breakpoint, next: Item[]) => {
      if (sameItems(itemsRef.current[b], next)) return;
      adopt(b, next);
      dirty.current[b] = true;
      later(b);
    },
    [adopt, later],
  );

  // Save what is waiting when the tab hides or the grid goes away.
  useEffect(() => {
    const all = () => BREAKPOINTS.forEach((b) => dirty.current[b] && void flush(b));
    const onHide = () => document.visibilityState === "hidden" && all();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", all);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", all);
      all();
    };
  }, [flush]);

  const reset = async () => {
    if (!bp) return;
    clearTimeout(timers.current[bp]);
    adopt(bp, defaultItems(registry, bp));
    dirty.current[bp] = false;
    if (!persistence) return;
    try {
      const r = await persistence.reset({ breakpoint: bp });
      if (r.ok) {
        tokens.current[bp] = null;
        return;
      }
    } catch {}
    dirty.current[bp] = true; // the row is still there: write the default over it
    later(bp);
  };

  const done = () => {
    setEditing(false);
    BREAKPOINTS.forEach((b) => dirty.current[b] && void flush(b));
  };

  const defs = useMemo(() => new Map(registry.map((d) => [d.id, d])), [registry]);
  const items = bp ? layouts[bp] : [];
  const saved = visibleItems(items).filter((i) => defs.has(i.id));
  const hidden = items.filter((i) => i.hidden && defs.has(i.id));
  // Outside edit mode the data may leave a block out or resize it; the rest fills in around it.
  const fitted = bp && !editing && fit ? fitItems(saved, (id) => fit(id, bp), bp, (id) => defs.get(id)?.sizes[bp].h) : null;
  const shown = fitted ?? saved;
  const gridLayout = bp
    ? shown.map((i) => {
        const s = defs.get(i.id)!.sizes[bp];
        // A fitted size may sit outside the block's limits (a one-row stand-in); the limits stretch to hold it.
        return { i: i.id, x: i.x, y: i.y, w: i.w, h: i.h, minW: Math.min(s.minW, i.w), maxW: Math.max(s.maxW, i.w), minH: Math.min(s.minH, i.h), maxH: Math.max(s.maxH, i.h) };
      })
    : [];
  const cfg = bp ? GRID[bp] : null;

  return (
    <div className={cn("flex flex-col gap-5 max-md:gap-3", className)} data-testid="dashboard-grid" data-editing={editing}>
      <div className={cn("flex min-h-10 items-center gap-2 max-md:gap-1", slot && !editing && "max-md:hidden")}>
        {lead}
        <div className="flex-1" />
        {trail}
        {editing ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="max-md:px-2" disabled={hidden.length === 0}>
                  Add block
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {hidden.map((i) => (
                  <DropdownMenuItem
                    key={i.id}
                    className="px-2.5 py-2 text-body"
                    onSelect={() => bp && commit(bp, showItem(itemsRef.current[bp], i.id, registry, bp))}
                  >
                    {defs.get(i.id)!.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" className="max-md:px-2" onClick={reset}>
              Reset
            </Button>
            <Button variant="primary" className="max-md:px-3" onClick={done}>
              Done
            </Button>
          </>
        ) : (
          <Button variant="ghost" className={cn(slot && "max-md:hidden")} disabled={!bp} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {slot &&
        !editing &&
        createPortal(
          // 36 px, the height of the phone scope menu button beside it.
          <Button variant="ghost" className="h-9 md:hidden" disabled={!bp} onClick={() => setEditing(true)} data-testid="phone-edit">
            Edit
          </Button>,
          slot,
        )}

      <div
        ref={containerRef}
        className={cn("hy-grid-root transition-opacity duration-200", reloading && "opacity-60")}
        aria-busy={reloading}
        data-breakpoint={bp ?? undefined}
      >
        {bp && cfg && mounted && (
          <ReactGridLayout
            className="hy-grid animate-hy-fade"
            width={width}
            layout={gridLayout}
            gridConfig={{ cols: cfg.cols, rowHeight: cfg.rowHeight, margin: [cfg.gap, cfg.gap], containerPadding: [0, 0], maxRows: Infinity }}
            dragConfig={{ enabled: editing, bounded: false, handle: ".hy-handle", threshold: 3 }}
            resizeConfig={{
              enabled: editing,
              handles: ["se"],
              // Not editing: a hidden stub, so react-grid-layout still gets its ref and nothing shows.
              handleComponent: (_axis, ref) =>
                editing ? (
                  <span
                    ref={ref}
                    role="img"
                    aria-label="Resize"
                    data-testid="resize-handle"
                    className={cn(TILE, "hy-resize absolute right-1.5 bottom-1.5 z-10 size-5 cursor-nwse-resize rounded-md border border-rule-2")}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
                      <path d="M9 3 3 9M9 6.5 6.5 9" />
                    </svg>
                  </span>
                ) : (
                  <span ref={ref} hidden />
                ),
            }}
            compactor={verticalCompactor}
            // A fitted layout is for this data only: never save it.
            onLayoutChange={(layout) => !fitted && commit(bp, applyGrid(itemsRef.current[bp], layout))}
          >
            {shown.map((i) => {
              const def = defs.get(i.id)!;
              return (
                <div key={i.id} data-block={i.id} data-testid={`block-${i.id}`}>
                  <div className="hy-lift">
                    <div className="hy-cell" inert={editing}>
                      <BlockContent def={def} content={content?.[i.id]} />
                    </div>
                    {editing && (
                      // Straddles the top edge, centered: clear of every label, pill and info dot a card can have.
                      <div className="absolute top-0 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-rule-2 bg-surface">
                        <button
                          type="button"
                          aria-label={`Move ${def.title}`}
                          data-testid="drag-handle"
                          className={cn(TILE, "hy-handle size-7 cursor-grab active:cursor-grabbing")}
                        >
                          <GripVertical className="size-4" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${def.title}`}
                          data-testid="remove-block"
                          className={cn(TILE, "size-7 border-l border-rule-2")}
                          onClick={() => commit(bp, hideItem(itemsRef.current[bp], i.id))}
                        >
                          <X className="size-4" strokeWidth={1.5} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </ReactGridLayout>
        )}
      </div>
    </div>
  );
}
