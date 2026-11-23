import { connection } from "next/server";
import { Suspense } from "react";

import { NotesLoading } from "@/components/notes/loading";
import { PageHeader } from "@/components/shell/page-header";

import { loadNotesData } from "./data";
import { NotesLive } from "./live";

export const metadata = { title: "Notes" };

type Search = Promise<Record<string, string | string[] | undefined>>;

async function NotesBody({ searchParams }: { searchParams: Search }) {
  // Dynamic before anything reads the environment, so a build with no Supabase env still prerenders the shell.
  await connection();
  const note = (await searchParams).note;
  const data = await loadNotesData(typeof note === "string" ? note : null);
  if (!data) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Notes" />
        <p role="alert" className="text-label text-ink-3">
          Sign in as the owner to see notes.
        </p>
      </div>
    );
  }
  return <NotesLive notes={data.notes} open={data.open} />;
}

/** The route skeleton is the fallback, so a click shows it at full strength and the page simply takes its place. */
export default function NotesPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<NotesLoading />}>
      <NotesBody searchParams={searchParams} />
    </Suspense>
  );
}
