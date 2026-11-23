"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, Card, Label, ListRow, Pill, drawerHref } from "@/components/kit";

import { REASON_LABEL } from "./format";
import { ROUTINE_PARAM } from "./routine-list";
import { useRoutines } from "./store";

/** Unattended steps waiting for a yes: each with Approve and Decline. Not shown when nothing waits. */
export function ApprovalsStrip() {
  const { data, actions, attempt } = useRoutines();
  const pathname = usePathname();
  const search = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  if (!data.approvals.length) return null;

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    await attempt(actions.decide(id, approve), approve ? "Approved." : "Declined.");
    setBusy(null);
  }

  return (
    <Card as="section" aria-label="Waiting for you">
      <div className="flex items-baseline gap-2">
        <Label>Waiting for you</Label>
        <span className="text-label text-ink-3 tabular-nums">{data.approvals.length}</span>
      </div>
      <ul>
        {data.approvals.map((a) => (
          <ListRow as="li" key={a.id} data-testid="approval" className="flex-wrap gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-body font-medium">{a.summary}</p>
              <p className="flex items-baseline gap-2 text-label text-ink-3">
                <Link href={drawerHref(pathname, search, ROUTINE_PARAM, a.routineId)} scroll={false} className="truncate underline-offset-2 hover:text-ink hover:underline">
                  {a.routineName}
                </Link>
                <Pill tone={a.danger ? "strong" : "default"}>{REASON_LABEL[a.reason]}</Pill>
              </p>
            </div>
            <div className="flex gap-2">
              <Button disabled={busy === a.id} onClick={() => void decide(a.id, true)} aria-label={`Approve: ${a.summary}`}>
                Approve
              </Button>
              <Button variant="ghost" disabled={busy === a.id} onClick={() => void decide(a.id, false)} aria-label={`Decline: ${a.summary}`}>
                Decline
              </Button>
            </div>
          </ListRow>
        ))}
      </ul>
    </Card>
  );
}
