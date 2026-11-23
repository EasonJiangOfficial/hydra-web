import { SEEDED_SECTIONS, type ActionResult, type EntitySlug, type Payment, type TaxActions, type TaxDoc, type TaxSection, type TaxesData } from "@/app/(app)/taxes/model";
import { fixtureData, fixtureLineTransactions } from "./fixtures";

type Slice = Pick<TaxesData, "rateBps" | "payments" | "documents">;

const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

/**
 * TaxActions on in-memory data, for /dev/taxes. Writes work and show; a reload starts over. Each
 * entity and year keeps its own changes, so switching the year and back finds them again.
 */
export function createMemoryActions(sections: readonly TaxSection[] = SEEDED_SECTIONS) {
  const slices = new Map<string, Slice>();
  let nextDoc = 900;
  const key = (entity: EntitySlug, year: number) => `${entity}-${year}`;
  const slice = (entity: EntitySlug, year: number) => {
    const k = key(entity, year);
    if (!slices.has(k)) {
      const { rateBps, payments, documents } = fixtureData(entity, year, sections);
      slices.set(k, { rateBps, payments, documents });
    }
    return slices.get(k)!;
  };

  const actions: TaxActions = {
    async saveRate({ entity, year, rateBps }) {
      slice(entity, year).rateBps = rateBps;
      return ok({ rateBps });
    },
    async savePayment({ entity, year, ...p }) {
      const s = slice(entity, year);
      const next: Payment = { quarter: p.quarter, amountCents: p.amountCents, paidOn: p.paidOn };
      s.payments = [...s.payments.filter((x) => x.quarter !== p.quarter), next].sort((a, b) => a.quarter - b.quarter);
      return ok(next);
    },
    async removePayment({ entity, year, quarter }) {
      const s = slice(entity, year);
      s.payments = s.payments.filter((x) => x.quarter !== quarter);
      return ok(null);
    },
    async lineTransactions({ entity, year, taxLineId }) {
      const line = fixtureData(entity, year, sections).lines.find((l) => l.id === taxLineId);
      if (!line) return { ok: false, error: { code: "not_found", message: "That line is gone" } };
      return ok(fixtureLineTransactions(line));
    },
    async uploadDocument({ entity, year, kind, payer, file }) {
      const doc: TaxDoc = {
        id: `00000000-0000-4000-8000-${String(nextDoc++).padStart(12, "0")}`,
        kind,
        name: file.name,
        payer,
        sizeBytes: file.size,
        addedOn: "2026-11-21",
      };
      const s = slice(entity, year);
      s.documents = [doc, ...s.documents];
      return ok(doc);
    },
    async documentUrl({ id }) {
      return ok({ url: `/dev/taxes?doc=${id}` });
    },
    async removeDocument({ id }) {
      for (const s of slices.values()) s.documents = s.documents.filter((d) => d.id !== id);
      return ok(null);
    },
  };

  /** The page's data for an entity and year, with every change made so far. */
  const snapshot = (entity: EntitySlug, year: number): TaxesData => ({ ...fixtureData(entity, year, sections), ...structuredClone(slice(entity, year)) });
  return { actions, snapshot };
}
