"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { cn } from "@/components/kit";
import { ColorDot, ColorPicker } from "@/components/ui/color-picker";
import { NO_VALUE_COLUMN, assignmentFor, buildColumns, groupModeOf, type ColumnModel, type GroupMode } from "@/lib/planning/board";
import { DEFAULT_BOARD_SORT, type BoardGroupBy, type PlanningTask, type TaskSortSpec } from "@/lib/planning/types";

import { containerOf, dropAt, moveAcross, rebase, type ColumnIds } from "./board-drag";
import { holdSelection, measure, pickUpTick, settle, SETTLE_MS } from "./drag-motion";
import { usePlanning } from "./planning-store";
import { TaskCard, TaskCardPreview } from "./task-card";

/** Cards stay put while one is dragged over its own column (no reordering there). */
const keepInPlace: SortingStrategy = () => null;

/** Press and hold this long on touch to pick a card up; a shorter touch is a tap or a scroll. */
const HOLD_MS = 220;

/**
 * After a settle: the smallest min-height that keeps the page where it is. The board shrinks to
 * its tallest column unless the page is scrolled so far down that a shorter board would pull it up.
 */
function heightThatKeepsScroll(board: HTMLElement): number | null {
  const natural = Math.max(0, ...Array.from(board.children, (c) => (c as HTMLElement).offsetHeight)) + parseFloat(getComputedStyle(board).paddingBottom || "0");
  const room = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  const keep = board.offsetHeight - Math.max(0, room);
  return keep > natural + 0.5 ? keep : null;
}

/** On a narrow screen the board snaps a column to its left edge: the snap point nearest now. */
function nearestSnap(board: HTMLElement): number | null {
  if (board.scrollWidth <= board.clientWidth || window.matchMedia("(min-width: 64rem)").matches) return null;
  const left = board.getBoundingClientRect().left;
  const max = board.scrollWidth - board.clientWidth;
  const points = Array.from(board.children, (c) => Math.min(max, c.getBoundingClientRect().left - left + board.scrollLeft));
  return points.reduce((a, b) => (Math.abs(b - board.scrollLeft) < Math.abs(a - board.scrollLeft) ? b : a), points[0] ?? board.scrollLeft);
}

function QuickAdd({ label, onAdd }: { label: string; onAdd: (title: string) => void }) {
  const [title, setTitle] = useState("");
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") setTitle("");
    else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const text = title.trim();
      if (!text) return;
      onAdd(text);
      setTitle("");
    }
  }
  return (
    <input
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={onKeyDown}
      aria-label={`New task in ${label}`}
      placeholder="+ New task, press Enter"
      className="h-[34px] w-full rounded-lg border border-dashed border-rule-2 bg-transparent px-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink focus:border-solid"
    />
  );
}

function Column({
  column,
  tasks,
  target,
  justDragged,
  reorder,
  onAdd,
  onColor,
  colorNone = false,
}: {
  column: ColumnModel;
  /** The cards in screen order (mid-drag: with the dragged card's slot where it would land). */
  tasks: readonly PlanningTask[];
  /** The dragged card is over this column. */
  target: boolean;
  justDragged: RefObject<boolean>;
  /** False: cards keep their order inside the column (a sort or a grouped board). */
  reorder: boolean;
  onAdd: (title: string) => void;
  /** A status, option or category column: its dot opens the color picker (null: None picked). */
  onColor?: (color: string | null) => void;
  /** The picker offers None (categories may have no color). */
  colorNone?: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${column.label} column`}
      data-column-id={column.id}
      data-drop-target={target || undefined}
      className={cn(
        "flex min-h-0 w-[85vw] max-w-80 shrink-0 snap-start flex-col gap-2 rounded-lg bg-tint p-3 transition-[background-color,box-shadow] duration-200 ease-hydra sm:w-72 lg:w-auto lg:max-w-none lg:min-w-[15rem] lg:flex-1 lg:basis-0",
        target && "bg-hover ring-1 ring-ink",
      )}
    >
      <h2 className="flex items-center gap-2 px-1 text-body font-medium">
        {onColor && (column.color || colorNone) ? (
          <ColorPicker value={column.color} onChange={onColor} allowNone={colorNone} label={column.label} className="-mx-1.5" />
        ) : (
          <ColorDot color={column.color} />
        )}
        <span className="flex-1 truncate">{column.label}</span>
        <span className="text-label font-normal text-ink-3 tabular-nums" aria-label={`${tasks.length} tasks`}>
          {tasks.length}
        </span>
      </h2>
      <SortableContext items={tasks.map((t) => t.id)} strategy={reorder ? verticalListSortingStrategy : keepInPlace}>
        <div className="flex min-h-12 flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} justDragged={justDragged} />
          ))}
        </div>
      </SortableContext>
      <QuickAdd label={column.label} onAdd={onAdd} />
    </section>
  );
}

/**
 * The Board: columns by status (cards reorder and move between columns), or grouped by category,
 * goal or a select property such as Priority (a drop sets the group). Drag with a mouse, press
 * and hold on touch, or use the keyboard handle on a focused card. "Move" on a card is the
 * no-drag path to the next status.
 *
 * Mid-drag the card's slot travels with the pointer (other cards slide aside), the column under
 * it tints, and on release the card settles into its slot (drag-motion.ts). A cancel (Escape, or
 * a drop off the board) settles it back.
 */
export function PlanningBoard(props: {
  tasks: readonly PlanningTask[];
  /** "status" (default), "category", "goal" or `prop:<select property id>`. */
  groupBy?: BoardGroupBy;
  /** Orders the cards in each column; manual (default) lets a card be dragged to a slot. */
  sort?: TaskSortSpec;
}) {
  const { snapshot, moveTask, createTask, updateTask, setTaskValue, setStatusColor, setOptionColor, setCategoryColor } = usePlanning();
  const sort = props.sort ?? DEFAULT_BOARD_SORT;
  const mode: GroupMode = groupModeOf(props.groupBy ?? "status", snapshot);
  const reduced = useReducedMotion() ?? false;
  const justDragged = useRef(false);
  const dndId = useId();
  const boardRef = useRef<HTMLDivElement>(null);
  const liftedRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<PlanningTask | null>(null);
  // The columns mid-drag, with the dragged card's slot moved; null when nothing is held.
  const [live, setLive] = useState<ColumnIds | null>(null);
  const liveRef = useRef<ColumnIds | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  // The held card's id, set at pick-up (state lags a render behind the drag events).
  const activeIdRef = useRef<string | null>(null);
  const keyboardRef = useRef(false);
  // The board keeps its height while a card is held and while it settles, so the page never
  // jumps when a column shrinks; after that it lets go only as far as the page allows.
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  // True from the drop until the settle and the snap back to a column are done.
  const [settling, setSettling] = useState(false);
  // Bumped on every pick-up and drop, so a stale after-settle step does nothing.
  const dragSeq = useRef(0);
  // Where the last announcement put the card, for the drop announcement.
  const spokenSpot = useRef("");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: HOLD_MS, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const columns = buildColumns(snapshot, props.tasks, mode, sort);
  // Grouped boards and sorts keep a card's slot; only status + manual reorders.
  const reorder = mode.kind === "status" && sort.key === "manual";
  const base: ColumnIds = Object.fromEntries(columns.map((c) => [c.id, c.tasks.map((t) => t.id)]));
  const byId = new Map(props.tasks.map((t) => [t.id, t]));

  /** The columns now: the store's, with the held card's slot where the drag has put it. */
  function slots(): ColumnIds {
    const l = liveRef.current;
    return l && activeIdRef.current ? rebase(base, l, activeIdRef.current) : base;
  }
  const ids = live && active ? rebase(base, live, active.id) : base;

  function setSlots(next: ColumnIds | null): void {
    liveRef.current = next;
    setLive(next);
  }

  // A drag cut short by an unmount (a view or route change) never reaches finish().
  useEffect(() => () => holdSelection(false), []);

  // Keyboard: a move to another column remounts the card, so its handle gets the focus back.
  useLayoutEffect(() => {
    const id = activeIdRef.current;
    if (!live || !id || !keyboardRef.current) return;
    const handle = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${id}"] [data-drag-handle]`);
    if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });
  }, [live]);

  const label = (columnId: string | undefined) => columns.find((c) => c.id === columnId)?.label ?? "";
  const titleOf = (id: string | number) => byId.get(String(id))?.title ?? "Card";
  /** Where the held card would land, in words: "In progress, 2 of 3". */
  function spot(activeId: string, overId: string): string {
    if (!reorder) return label(containerOf(base, overId));
    const cols = slots();
    const col = containerOf(cols, activeId);
    if (!col) return "";
    return `${label(col)}, ${cols[col].indexOf(activeId) + 1} of ${cols[col].length}`;
  }
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${titleOf(a.id)}.`,
    onDragOver: ({ active: a, over }) => {
      if (!over) return `${titleOf(a.id)} is off the board.`;
      spokenSpot.current = spot(String(a.id), String(over.id));
      return `${titleOf(a.id)}: ${spokenSpot.current}.`;
    },
    onDragEnd: ({ active: a, over }) => (over ? `Dropped ${titleOf(a.id)}${spokenSpot.current ? ` in ${spokenSpot.current}` : ""}.` : `${titleOf(a.id)} put back.`),
    onDragCancel: ({ active: a }) => `${titleOf(a.id)} put back.`,
  };
  const screenReaderInstructions = {
    draggable: "Press Space to pick up the card. Arrow keys move it, Space drops it, Escape puts it back.",
  };

  /**
   * The column under the pointer (in a gap between columns: the nearest one; off the board:
   * none, so letting go there cancels), then the card in it nearest the dragged card. The
   * keyboard has no pointer and uses the dragged card's box.
   */
  const collide: CollisionDetection = (args) => {
    const p = args.pointerCoordinates;
    let pool = p ? pointerWithin(args) : rectIntersection(args);
    const box = boardRef.current?.getBoundingClientRect();
    if (p && pool.length === 0 && box && p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) {
      pool = closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => String(d.id) in base) }).slice(0, 1);
    }
    const column = pool.find((c) => String(c.id) in base);
    if (!column) return [];
    const inColumn = slots()[String(column.id)] ?? [];
    const cards = args.droppableContainers.filter((d) => inColumn.includes(String(d.id)));
    if (cards.length === 0) return [column];
    if (!p || !reorder) return closestCenter({ ...args, droppableContainers: cards });
    // A pointer: the held card's middle against each other card's middle, so the slot goes below a
    // card once the held card is past its middle and above it before (no jump back on entry).
    const y = args.collisionRect.top + args.collisionRect.height / 2;
    const activeId = String(args.active.id);
    const others = inColumn.filter((id) => id !== activeId);
    const mid = (id: string) => {
      const r = args.droppableRects.get(id);
      return r ? r.top + r.height / 2 : Infinity;
    };
    const k = others.filter((id) => mid(id) < y).length;
    const a = inColumn.indexOf(activeId);
    const overId = a < 0 ? others[Math.min(k, others.length - 1)] : k === a ? activeId : k < a ? others[k] : others[k - 1];
    const hit = cards.find((d) => String(d.id) === overId);
    return hit ? [{ id: hit.id, data: { droppableContainer: hit, value: 0 } }] : [column];
  };

  async function addTask(column: ColumnModel, title: string): Promise<void> {
    if (mode.kind === "status") {
      await createTask({ title, statusId: column.id });
      return;
    }
    // A new card starts in the first status and takes the column's group.
    const first = [...snapshot.statuses].sort((a, b) => a.position - b.position)[0];
    if (!first) return;
    const a = assignmentFor(mode, column.id);
    const id = await createTask({ title, statusId: first.id, ...(a.patch ?? {}) });
    if (id && a.propertyId && a.value) await setTaskValue(id, a.propertyId, a.value);
  }

  /** Ends any drag: the card settles into wherever the next commit puts it. */
  function finish(activeId: string): void {
    settle({
      root: boardRef.current,
      attr: "data-task-id",
      dropped: activeId,
      lifted: liftedRef.current?.getBoundingClientRect() ?? null,
      before: measure(boardRef.current, "data-task-id"),
      reduced,
      inkOutline: true,
    });
    holdSelection(false);
    setActive(null);
    setSettling(true);
    setSlots(null);
    activeIdRef.current = null;
    keyboardRef.current = false;
    setOverColumn(null);
    // The height and the scroll snap stay as they were until the card has landed; then the
    // board lets go of the height the page needs no more and glides to the nearest column.
    const seq = ++dragSeq.current;
    window.setTimeout(() => {
      const board = boardRef.current;
      if (seq !== dragSeq.current || !board) return;
      setHeldHeight(heightThatKeepsScroll(board));
      const to = nearestSnap(board);
      if (to === null || Math.abs(to - board.scrollLeft) < 1) {
        setSettling(false);
        return;
      }
      const done = () => {
        board.removeEventListener("scrollend", done);
        if (seq === dragSeq.current) setSettling(false);
      };
      board.addEventListener("scrollend", done);
      window.setTimeout(done, 600); // no scrollend (older WebKit)
      board.scrollTo({ left: to, behavior: reduced ? "instant" : "smooth" });
    }, SETTLE_MS + 34);
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  function onDragStart(event: DragStartEvent): void {
    pickUpTick(event.activatorEvent);
    holdSelection(true);
    dragSeq.current++;
    activeIdRef.current = String(event.active.id);
    keyboardRef.current = event.activatorEvent instanceof KeyboardEvent;
    setHeldHeight(boardRef.current?.offsetHeight ?? null);
    setActive(byId.get(String(event.active.id)) ?? null);
    setOverColumn(containerOf(base, String(event.active.id)) ?? null);
    if (reorder) setSlots(base);
  }

  function onDragOver({ active: dragged, over }: DragOverEvent): void {
    const cols = slots();
    setOverColumn(over ? (containerOf(cols, String(over.id)) ?? null) : null);
    if (!reorder || !over) return;
    // Above or below the card under it: by the held card's middle (where the pointer holds it).
    const box = dragged.rect.current.translated;
    const below = box ? box.top + box.height / 2 > over.rect.top + over.rect.height / 2 : false;
    const next = moveAcross(cols, String(dragged.id), String(over.id), below);
    if (next !== cols) setSlots(next);
  }

  function onDragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const cols = slots();
    finish(activeId);
    if (!event.over) return;
    const overId = String(event.over.id);
    if (mode.kind !== "status" || !reorder) {
      // Another column sets the status or the group; inside one nothing moves (a sort places it).
      const from = containerOf(base, activeId);
      const to = containerOf(base, overId);
      if (!to || from === to) return;
      if (mode.kind === "status") void moveTask(activeId, { statusId: to, afterId: null, beforeId: null });
      else {
        const a = assignmentFor(mode, to);
        if (a.patch) void updateTask(activeId, a.patch);
        else if (a.propertyId) void setTaskValue(activeId, a.propertyId, a.value ?? null);
      }
      return;
    }
    const drop = dropAt(base, cols, activeId, overId);
    if (drop) void moveTask(activeId, { statusId: drop.columnId, afterId: drop.afterId, beforeId: drop.beforeId });
  }

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={collide}
      accessibility={{ announcements, screenReaderInstructions }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={(e) => finish(String(e.active.id))}
    >
      {/* Scroll snapping is off mid-drag: with it on, the edge auto-scroll jumps a whole column a frame. */}
      <div
        ref={boardRef}
        className={cn("flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-2 lg:snap-none", active || settling ? "snap-none" : "snap-x snap-mandatory")}
        data-testid="board"
        data-dragging={active ? "" : undefined}
        style={heldHeight ? { minHeight: heldHeight } : undefined}
      >
        {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            tasks={(ids[column.id] ?? []).flatMap((id) => byId.get(id) ?? [])}
            target={active !== null && overColumn === column.id}
            justDragged={justDragged}
            reorder={reorder}
            onAdd={(title) => void addTask(column, title)}
            onColor={
              column.id === NO_VALUE_COLUMN
                ? undefined
                : mode.kind === "status"
                  ? (c) => c && void setStatusColor(column.id, c)
                  : mode.kind === "property"
                    ? (c) => c && void setOptionColor(mode.property.id, column.id, c)
                    : mode.kind === "category"
                      ? (c) => void setCategoryColor(column.id, c)
                      : undefined
            }
            colorNone={mode.kind === "category"}
          />
        ))}
      </div>
      {/* No built-in drop animation: settle() glides the real card in from the lifted copy. */}
      <DragOverlay dropAnimation={null}>{active ? <TaskCardPreview ref={liftedRef} task={active} /> : null}</DragOverlay>
    </DndContext>
  );
}
