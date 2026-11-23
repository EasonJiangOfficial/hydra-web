"use client";

import { Plus } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button, Input, cn } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorDot, ColorPicker, ColorPill } from "@/components/ui/color-picker";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { PROPERTY_TYPES, type PlanningProperty, type PropertyType, type PropertyValue } from "@/lib/planning/properties";
import type { PlanningTask } from "@/lib/planning/types";

import { usePlanning } from "./planning-store";

const TYPE_LABELS: Readonly<Record<PropertyType, string>> = {
  select: "Select",
  multi_select: "Multi-select",
  number: "Number",
  text: "Text",
  checkbox: "Checkbox",
  date: "Date",
  url: "Link",
};

/** Enter commits and leaves the field; Escape puts back what was there. */
function commitKeys(e: KeyboardEvent<HTMLInputElement>, saved: string): void {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  } else if (e.key === "Escape") {
    e.currentTarget.value = saved;
    e.currentTarget.blur();
  }
}

/**
 * One property of one task. A value is saved when the field loses focus (or on pick); an empty
 * field clears it. `compact` is the Table cell: no label, and a multi-select reads as text.
 */
export function PropertyValueEditor({ task, property, compact = false }: { task: PlanningTask; property: PlanningProperty; compact?: boolean }) {
  const { setTaskValue, createOption, setOptionColor } = usePlanning();
  const value: PropertyValue | undefined = task.values[property.id];
  const set = (v: PropertyValue | null) => void setTaskValue(task.id, property.id, v);
  const label = `${property.name} of ${task.title}`;
  const field = compact ? "h-8 border-transparent bg-transparent px-2 hover:border-rule-2" : "";
  const [adding, setAdding] = useState("");

  switch (property.type) {
    case "select":
      return (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className={cn("flex min-w-0 items-center", compact ? "gap-0.5" : "gap-1.5")}>
            {/* The dot slot is kept when there is no color, so the select never shifts. */}
            <ColorDot reserve color={value?.type === "select" ? property.options.find((o) => o.id === value.optionId)?.color : null} />
            <Select
              aria-label={label}
              value={value?.type === "select" ? value.optionId : ""}
              onChange={(e) => set(e.target.value ? { type: "select", optionId: e.target.value } : null)}
              // Each option shows its color dot in the list.
              options={[
                { value: "", label: compact ? "—" : "None", icon: <ColorDot reserve color={null} /> },
                ...property.options.map((o) => ({ value: o.id, label: o.label, icon: <ColorDot reserve color={o.color} /> })),
              ]}
              className={cn(compact ? "h-8 min-w-[102px] border-transparent bg-transparent hover:border-rule-2" : "flex-1")}
            />
          </span>
          {compact ? null : (
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              {property.options.map((o) => (
                <span key={o.id} className="inline-flex items-center gap-0.5">
                  <ColorPicker value={o.color} onChange={(c) => c && void setOptionColor(property.id, o.id, c)} label={o.label} />
                  <ColorPill color={o.color}>{o.label}</ColorPill>
                </span>
              ))}
            </span>
          )}
          {compact ? null : (
            <Input
              aria-label={`Add an option to ${property.name}`}
              placeholder="+ New option, press Enter"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key !== "Enter" || !adding.trim()) return;
                e.preventDefault();
                const id = await createOption(property.id, adding);
                setAdding("");
                if (id) set({ type: "select", optionId: id });
              }}
            />
          )}
        </div>
      );
    case "multi_select": {
      if (compact)
        return (
          <span className="flex flex-wrap gap-1 px-2">
            {value?.type === "multi_select"
              ? property.options
                  .filter((o) => value.optionIds.includes(o.id))
                  .map((o) => (
                    <ColorPill key={o.id} color={o.color}>
                      {o.label}
                    </ColorPill>
                  ))
              : null}
          </span>
        );
      const picked = value?.type === "multi_select" ? value.optionIds : [];
      return (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {property.options.map((o) => (
            <label key={o.id} className="flex min-h-7 cursor-pointer items-center gap-2 text-body">
              <Checkbox
                // Named by the option alone: the color button inside this <label> must not join its name.
                aria-label={o.label}
                checked={picked.includes(o.id)}
                onChange={(e) => {
                  const next = e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id);
                  set(next.length ? { type: "multi_select", optionIds: next } : null);
                }}
              />
              <ColorPicker value={o.color} onChange={(c) => c && void setOptionColor(property.id, o.id, c)} label={o.label} />
              <ColorPill color={o.color}>{o.label}</ColorPill>
            </label>
          ))}
          <Input
            aria-label={`Add an option to ${property.name}`}
            placeholder="+ New option, press Enter"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !adding.trim()) return;
              e.preventDefault();
              const id = await createOption(property.id, adding);
              setAdding("");
              if (id) set({ type: "multi_select", optionIds: [...picked, id] });
            }}
          />
        </div>
      );
    }
    case "number": {
      const saved = value?.type === "number" ? String(value.value) : "";
      return (
        <Input
          key={saved}
          type="number"
          inputMode="decimal"
          aria-label={label}
          defaultValue={saved}
          className={field}
          onKeyDown={(e) => commitKeys(e, saved)}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw === saved) return;
            const n = Number(raw);
            set(raw === "" ? null : Number.isFinite(n) ? { type: "number", value: n } : null);
          }}
        />
      );
    }
    case "text":
    case "url": {
      const saved = value?.type === "text" || value?.type === "url" ? value.value : "";
      return (
        <Input
          key={saved}
          type={property.type === "url" ? "url" : "text"}
          aria-label={label}
          defaultValue={saved}
          placeholder={property.type === "url" ? "https://" : undefined}
          className={field}
          onKeyDown={(e) => commitKeys(e, saved)}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw === saved) return;
            set(raw === "" ? null : property.type === "url" ? { type: "url", value: raw } : { type: "text", value: raw });
          }}
        />
      );
    }
    case "checkbox":
      return (
        <Checkbox
          aria-label={label}
          className="ml-2"
          checked={value?.type === "checkbox"}
          onChange={(e) => set(e.target.checked ? { type: "checkbox", value: true } : null)}
        />
      );
    case "date": {
      const saved = value?.type === "date" ? value.value : "";
      return (
        <DatePicker
          key={saved}
          aria-label={label}
          defaultValue={saved}
          className={field}
          onChange={(e) => set(e.target.value ? { type: "date", value: e.target.value } : null)}
        />
      );
    }
  }
}

/** "+ Add a property": a name and a type. The new property shows on every task. */
export function AddPropertyForm() {
  const { createProperty } = usePlanning();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("select");

  if (!open) {
    return (
      <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
        <Plus aria-hidden strokeWidth={1.5} />
        Add a property
      </Button>
    );
  }
  async function submit() {
    if (!name.trim()) return;
    const id = await createProperty({ name, type });
    if (id) {
      setName("");
      setOpen(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-tint p-3">
      <Input
        autoFocus
        aria-label="Property name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <Select aria-label="Property type" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
        {PROPERTY_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </Select>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void submit()} disabled={!name.trim()}>
          Add
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
