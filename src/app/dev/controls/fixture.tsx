"use client";

import { Banknote, CreditCard, Landmark, PiggyBank } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, DetailDrawer, Label, drawerHref } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker, DateTimePicker, TimePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";

const KINDS = [
  { value: "checking", label: "Checking", icon: <Landmark strokeWidth={1.5} /> },
  { value: "savings", label: "Savings", icon: <PiggyBank strokeWidth={1.5} /> },
  { value: "credit", label: "Credit card", icon: <CreditCard strokeWidth={1.5} /> },
  { value: "cash", label: "Cash", icon: <Banknote strokeWidth={1.5} />, disabled: true },
];

const CATEGORIES = [
  "Advertising",
  "Bank fees",
  "Car and truck",
  "Contract labor",
  "Dining out",
  "Education",
  "Equipment",
  "Gifts",
  "Groceries",
  "Insurance",
  "Office supplies",
  "Phone",
  "Rent",
  "Rideshare and transit",
  "Software",
  "Travel",
  "Utilities",
];

function Row({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-row={label}>
      <Label as="label" htmlFor={id}>
        {label}
      </Label>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-xl border border-rule p-5">
      <h2 className="text-section">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function ControlsFixture() {
  const [kind, setKind] = useState("checking");
  const [cat, setCat] = useState("");
  const [many, setMany] = useState<string[]>(["Software"]);
  const [day, setDay] = useState("2026-11-21");
  const [from, setFrom] = useState("2026-11-03");
  const [to, setTo] = useState("2026-11-18");
  const [time, setTime] = useState("09:30");
  const [alert, setAlert] = useState("2026-11-22T18:45");
  const [hide, setHide] = useState(true);
  const [all, setAll] = useState(false);
  const [sent, setSent] = useState<string>("");
  const [tag, setTag] = useState("");

  return (
    <div className="flex flex-col gap-6">
      <output data-testid="values" className="rounded-lg bg-tint p-3 font-[inherit] text-label text-ink-2 tabular-nums">
        {JSON.stringify({ kind, cat, many, day, from, to, time, alert, hide, tag })}
      </output>

      <Section title="Select">
        <Row label="Account type" id="c-kind">
          <Select id="c-kind" value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} />
        </Row>
        <Row label="Category (searchable, over 12)" id="c-cat">
          <Select id="c-cat" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">No category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Grouped" id="c-group">
          <Select id="c-group" aria-label="Grouped" defaultValue="uber">
            <optgroup label="Transport">
              <option value="uber">Uber</option>
              <option value="gas">Gas</option>
            </optgroup>
            <optgroup label="Food">
              <option value="dining">Dining out</option>
            </optgroup>
          </Select>
        </Row>
        <Row label="Many" id="c-many">
          <Select id="c-many" aria-label="Many" multiple placeholder="Pick categories" value={many} onChange={(e) => setMany(Array.from(e.target.selectedOptions, (o) => o.value))}>
            {CATEGORIES.slice(0, 6).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Placeholder">
          <Select aria-label="Placeholder" placeholder="Pick a business">
            <option value="ugc">UGC</option>
            <option value="personal">Personal</option>
          </Select>
        </Row>
        <Row label="Disabled">
          <Select aria-label="Disabled" disabled value="ugc">
            <option value="ugc">UGC</option>
          </Select>
        </Row>
      </Section>

      <Section title="Date">
        <Row label="Due" id="c-day">
          <DatePicker id="c-day" value={day} onChange={(e) => setDay(e.target.value)} />
        </Row>
        <Row label="Empty">
          <DatePicker aria-label="Empty date" />
        </Row>
        <Row label="From" id="c-from">
          <DatePicker id="c-from" aria-label="From" rangeEnd={to} max={to || undefined} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Row>
        <Row label="To" id="c-to">
          <DatePicker id="c-to" aria-label="To" rangeStart={from} min={from || undefined} value={to} onChange={(e) => setTo(e.target.value)} />
        </Row>
        <Row label="Disabled">
          <DatePicker aria-label="Disabled date" disabled value="2026-11-21" />
        </Row>
      </Section>

      <Section title="Time">
        <Row label="Time" id="c-time">
          <TimePicker id="c-time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Row>
        <Row label="Alert" id="c-alert">
          <DateTimePicker id="c-alert" aria-label="Alert" value={alert} onChange={(e) => setAlert(e.target.value)} />
        </Row>
      </Section>

      <Section title="Suggestions">
        <Row label="Tag" id="c-tag">
          <Combobox id="c-tag" suggestions={CATEGORIES} placeholder="None" value={tag} onChange={(e) => setTag(e.target.value)} />
        </Row>
      </Section>

      <Section title="Checkbox">
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-body">
          <Checkbox checked={hide} onChange={(e) => setHide(e.target.checked)} />
          Hide done
        </label>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-body">
          <Checkbox checked={all} indeterminate={!all} onChange={(e) => setAll(e.target.checked)} />
          Select all (some picked)
        </label>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-body">
          <Checkbox checked={false} />
          Off
        </label>
        <label className="flex min-h-8 cursor-not-allowed items-center gap-2 text-body text-ink-3">
          <Checkbox checked disabled />
          Disabled
        </label>
      </Section>

      <Section title="Form">
        <form
          data-testid="form"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))));
          }}
        >
          <Select aria-label="Form kind" name="kind" defaultValue="savings" options={KINDS} />
          <DatePicker aria-label="Form day" name="day" defaultValue="2026-11-21" />
          <TimePicker aria-label="Form time" name="time" defaultValue="07:15" />
          <label className="flex items-center gap-2 text-body">
            <Checkbox name="agree" defaultChecked />
            Agree
          </label>
          <Button type="submit" variant="primary" className="self-start">
            Submit
          </Button>
          <output data-testid="sent" className="text-label text-ink-3">
            {sent}
          </output>
        </form>
      </Section>

      <Section title="In a slide-out">
        <Button asChild>
          <Link href={drawerHref("/dev/controls", "", "task", "demo")} scroll={false}>
            Open slide-out
          </Link>
        </Button>
      </Section>
      <DetailDrawer param="task" label="Task">
        <div className="flex flex-col gap-3">
          <Row label="Status" id="d-kind">
            <Select id="d-kind" value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} />
          </Row>
          <Row label="Due" id="d-day">
            <DatePicker id="d-day" value={day} onChange={(e) => setDay(e.target.value)} />
          </Row>
          <Row label="Time" id="d-time">
            <TimePicker id="d-time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Row>
          <Row label="Category" id="d-tag">
            <Combobox id="d-tag" suggestions={CATEGORIES} placeholder="None" value={tag} onChange={(e) => setTag(e.target.value)} />
          </Row>
        </div>
      </DetailDrawer>
    </div>
  );
}
