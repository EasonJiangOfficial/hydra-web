"use client";

import { Select, type SelectProps } from "@/components/ui/select";
import type { Lookups } from "./types";

/** The categories a business can use, top level first with subcategories grouped under their parent. */
export function categoryGroups(l: Lookups, entityId: string | null | undefined, selectedId?: string | null) {
  const usable = l.categories.filter(
    (c) => c.id === selectedId || (!c.archived && c.kind !== "transfer" && (c.entity_id === null || !entityId || c.entity_id === entityId)),
  );
  const tops = usable.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name));
  return tops.map((top) => ({ top, children: usable.filter((c) => c.parent_id === top.id).sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** A category picker. `placeholder` is the empty choice ("No category", "All categories"). */
export function CategorySelect({
  lookups,
  entityId,
  value,
  onChange,
  placeholder,
  className,
  ...props
}: {
  lookups: Lookups;
  entityId?: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder: string;
} & Omit<SelectProps, "value" | "onChange" | "children">) {
  return (
    <Select className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} {...props}>
      <option value="">{placeholder}</option>
      {categoryGroups(lookups, entityId, value).map(({ top, children }) =>
        children.length ? (
          <optgroup key={top.id} label={top.name}>
            <option value={top.id}>{top.name}</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={top.id} value={top.id}>
            {top.name}
          </option>
        ),
      )}
    </Select>
  );
}

export function EntitySelect({
  lookups,
  value,
  onChange,
  placeholder,
  className,
  ...props
}: {
  lookups: Lookups;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Without it there is no empty choice. */
  placeholder?: string;
} & Omit<SelectProps, "value" | "onChange" | "children">) {
  return (
    <Select className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {lookups.entities.filter((e) => e.status !== "closed" || e.id === value).map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </Select>
  );
}

export function AccountSelect({
  lookups,
  value,
  onChange,
  placeholder,
  className,
  ...props
}: {
  lookups: Lookups;
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
} & Omit<SelectProps, "value" | "onChange" | "children">) {
  return (
    <Select className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {lookups.accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {(a.nickname ?? a.name) + (a.mask ? ` ${a.mask}` : "")}
        </option>
      ))}
    </Select>
  );
}
