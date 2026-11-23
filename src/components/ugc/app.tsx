"use client";

import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";

import * as server from "@/lib/ugc/actions";
import { LOGO_BUCKET, logoFileProblem, logoObjectPath } from "@/lib/ugc/logo";
import type { ActionResult, DealDbRow } from "@/lib/ugc/schemas";
import { createBrowserClient } from "@/lib/supabase/client";

import { UgcProvider } from "./store";
import type { UgcActions, UgcRaw } from "./types";
import { UgcWorkspace } from "./workspace";

type Action = (input: never) => Promise<ActionResult<unknown>>;

/** The same server action, which also re-renders the page's data once it succeeds. */
function refreshing<F extends Action>(fn: F, refresh: () => void): F {
  return (async (input: Parameters<F>[0]) => {
    const res = await fn(input);
    if (res.ok) refresh();
    return res;
  }) as F;
}

/**
 * Upload with the owner's browser session (the bucket's policies are owner only, and a file this size
 * does not fit a server action body), then point the deal at it. The page signs a URL for it on refresh.
 */
async function uploadDealLogo({ dealId, file }: { dealId: string; file: File }): Promise<ActionResult<DealDbRow>> {
  const problem = logoFileProblem(file);
  if (problem) return { ok: false, error: { code: "invalid_input", message: problem } };
  const path = logoObjectPath(dealId, file.type);
  const { error } = await createBrowserClient().storage.from(LOGO_BUCKET).upload(path, file, { contentType: file.type });
  if (error) return { ok: false, error: { code: "db_error", message: `Could not upload the logo: ${error.message}` } };
  return server.updateDeal({ id: dealId, logoPath: path });
}

/** The real tracker: the page's rows, and `src/lib/ugc/actions.ts` for every write. */
export function UgcApp({ raw }: { raw: UgcRaw }) {
  const router = useRouter();
  const [, start] = useTransition();
  const actions = useMemo<UgcActions>(() => {
    const r = <F extends Action>(fn: F) => refreshing(fn, () => start(() => router.refresh()));
    return {
      createDeal: r(server.createDeal),
      updateDeal: r(server.updateDeal),
      pauseDeal: r(server.pauseDeal),
      resumeDeal: r(server.resumeDeal),
      endDeal: r(server.endDeal),
      deleteDeal: r(server.deleteDeal),
      addPost: r(server.addPost),
      editPost: r(server.editPost),
      excludePost: r(server.excludePost),
      unexcludePost: r(server.unexcludePost),
      deletePost: r(server.deletePost),
      linkPosts: r(server.linkPosts),
      unlinkPost: r(server.unlinkPost),
      setDayTarget: r(server.setDayTarget),
      matchPayment: r(server.matchPayment),
      unmatchPayment: r(server.unmatchPayment),
      rejectPayoutMatch: r(server.rejectPayoutMatch),
      decidePayoutRule: r(server.decidePayoutRule),
      undoRejectPayoutMatch: r(server.undoRejectPayoutMatch),
      removePayoutRule: r(server.removePayoutRule),
      setViews: r(server.setViews),
      uploadDealLogo: r(uploadDealLogo),
    };
  }, [router]);
  return (
    <UgcProvider raw={raw} actions={actions} basePath="/ugc">
      <UgcWorkspace />
    </UgcProvider>
  );
}
