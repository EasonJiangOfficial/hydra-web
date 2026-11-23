"use client";

import { Suspense, createContext, use, useCallback, useMemo, useOptimistic, useRef, useTransition, type ReactNode, type TransitionStartFunction } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Seg } from "@/components/kit/seg";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SEEDED_ENTITIES, parseScope, scopeChoices, type Entity, type Scope } from "@/lib/entities/model";

/** Entity scope, kept in the URL: `?scope=<entity slug>`; absent means All. */
export { parseScope, type Scope };

type EntitiesValue = readonly Entity[] | PromiseLike<readonly Entity[]>;
const EntitiesCtx = createContext<EntitiesValue>(SEEDED_ENTITIES);
/** One transition for every switch under the provider, so the page can dim while the new scope loads. */
const PendingCtx = createContext<{ pending: boolean; start: TransitionStartFunction } | null>(null);

/**
 * The entity list the switch offers (Personal and the active businesses). The app layout passes the read as an
 * un-awaited promise so the shell stays static; fixture pages pass a list. Without a provider: Personal and UGC.
 * It also holds the switch's transition: `useScopePending()` is true from a pick until the new figures show.
 */
export function ScopeEntitiesProvider({ entities, children }: { entities: EntitiesValue; children: ReactNode }) {
  const [pending, start] = useTransition();
  const value = useMemo(() => ({ pending, start }), [pending, start]);
  return (
    <EntitiesCtx value={entities}>
      <PendingCtx value={value}>{children}</PendingCtx>
    </EntitiesCtx>
  );
}

/** True while a scope switch is loading the new scope (Reports' month switch pattern: dim, aria-busy). */
export function useScopePending(): boolean {
  return use(PendingCtx)?.pending ?? false;
}

function useEntities(): readonly Entity[] {
  const v = use(EntitiesCtx);
  return "then" in v ? use(v as PromiseLike<readonly Entity[]>) : (v as readonly Entity[]);
}

/** A nav href that carries the scope. Other params are page-local, so they are dropped. */
export function scopedHref(href: string, scope: Scope) {
  if (scope === "all") return href;
  return `${href}${href.includes("?") ? "&" : "?"}scope=${scope}`;
}

/** The pages whose figures the scope filters. The switch shows only there (owner, 2026-11-22). */
const SCOPED = ["/", "/transactions", "/reports"];

/**
 * True when the page at `pathname` reads the scope. Fixture pages under /dev count as the page they stand for
 * ("/dev/reports" is Reports, "/dev/dashboard" and "/dev/shell" the Dashboard).
 */
export function scopeApplies(pathname: string): boolean {
  let p = pathname.replace(/^\/dev(?=\/|$)/, "").replace(/^\/shell\/loading(?=\/)/, "") || "/";
  if (p === "/shell" || p === "/dashboard") p = "/";
  return SCOPED.some((s) => (s === "/" ? p === "/" : p === s || p.startsWith(`${s}/`)));
}

/**
 * Reads and writes the scope. It calls `useSearchParams`, so with cacheComponents the caller must sit inside
 * `<Suspense>` (or use `WithScope` / `ScopeSwitch`, which bring their own boundary).
 */
export function useScope() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const shared = use(PendingCtx);
  const [, own] = useTransition();
  const start = shared?.start ?? own;
  const scope = parseScope(params.get("scope"));
  const setScope = useCallback(
    (next: Scope) => {
      const q = new URLSearchParams(params.toString());
      if (next === "all") q.delete("scope");
      else q.set("scope", next);
      const s = q.toString();
      start(() => router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false }));
    },
    [params, pathname, router, start],
  );
  return { scope, setScope, start, href: (path: string) => scopedHref(path, scope) };
}

function ScopeReader({ children }: { children: (scope: Scope) => ReactNode }) {
  return children(useScope().scope);
}

/** Renders `children(scope)`. Prerenders with "all", then swaps in the URL's scope on the client. */
export function WithScope({ children }: { children: (scope: Scope) => ReactNode }) {
  return (
    <Suspense fallback={children("all")}>
      <ScopeReader>{children}</ScopeReader>
    </Suspense>
  );
}

type SwitchProps = { className?: string };
type ViewProps = { value: Scope; onPick?: (s: Scope) => void; entities?: readonly Entity[] };

function ScopeSeg({ value, onPick, className, entities = SEEDED_ENTITIES }: SwitchProps & ViewProps) {
  return (
    <Seg
      aria-label="Scope"
      items={scopeChoices(entities, value).map((o) => ({ value: o.value, label: o.label }))}
      value={value}
      onValueChange={(v) => onPick?.(parseScope(v))}
      className={className}
    />
  );
}

/**
 * The phone's scope control: one 36 px outline button with the scope's name and a chevron, opening a menu of
 * every scope with a check on the current one. A strip of choices clipped names at 375 px; a menu never does.
 */
function ScopeMenuView({ value, onPick, entities = SEEDED_ENTITIES }: ViewProps) {
  const choices = scopeChoices(entities, value).map((o) => ({
    value: o.value,
    label: entities.some((e) => e.slug === o.value && e.kind === "personal") ? o.short : o.label,
  }));
  const name = choices.find((o) => o.value === value)?.label ?? "All";
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A long business name truncates past 40% of the header; the menu shows it in full. */}
        <Button ref={trigger} variant="outline" aria-label={`Scope: ${name}`} className="h-9 max-w-[40vw] gap-1 pr-2.5 pl-3" data-testid="scope-menu">
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown aria-hidden strokeWidth={1.5} className="text-ink-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // A tap on the button is never "outside": a menu still fading out from the last pick would take it as one
        // and close the menu that tap just opened.
        onPointerDownOutside={(e) => {
          if (trigger.current?.contains(e.target as Node)) e.preventDefault();
        }}
        align="end"
        collisionPadding={16} className="w-max max-w-[calc(100vw-32px)] min-w-48 bg-surface">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick?.(parseScope(v))}>
          {choices.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} className="h-10 cursor-pointer rounded-md pr-9 pl-3 text-body focus:bg-tint focus:text-ink">
              <span className="min-w-0 truncate">{o.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The live pick: shows at once, then the URL (and the page) follow when the new scope has loaded. */
function useLivePick(): ViewProps {
  const { scope, setScope, start } = useScope();
  const [shown, show] = useOptimistic(scope);
  const onPick = (next: Scope) =>
    start(() => {
      show(next);
      setScope(next);
    });
  return { value: shown, onPick, entities: useEntities() };
}

function LiveSeg(props: SwitchProps) {
  return <ScopeSeg {...props} {...useLivePick()} />;
}

function LiveMenu() {
  return <ScopeMenuView {...useLivePick()} />;
}

/** The All / Personal / businesses segmented control (desktop). */
export function ScopeSwitch(props: SwitchProps) {
  return (
    <Suspense fallback={<ScopeSeg {...props} value="all" />}>
      <LiveSeg {...props} />
    </Suspense>
  );
}

/** The phone header's scope menu: the same scopes and the same switch transition as `ScopeSwitch`. */
export function ScopeMenu() {
  return (
    <Suspense fallback={<ScopeMenuView value="all" />}>
      <LiveMenu />
    </Suspense>
  );
}
