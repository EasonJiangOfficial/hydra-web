"use client";

import { createContext, use, useMemo, type ReactNode } from "react";

import { buildModel, type Model } from "./model";
import type { UgcActions, UgcRaw } from "./types";

type Ctx = {
  raw: UgcRaw;
  model: Model;
  actions: UgcActions;
  /** Where this tracker lives: "/ugc" on the app, "/dev/ugc" on the fixture. Links and the URL params hang off it. */
  basePath: string;
};

const UgcCtx = createContext<Ctx | null>(null);

/** Holds the rows and the actions. The model is rebuilt whenever the rows change. */
export function UgcProvider({
  raw,
  actions,
  basePath,
  children,
}: {
  raw: UgcRaw;
  actions: UgcActions;
  basePath: string;
  children: ReactNode;
}) {
  const model = useMemo(() => buildModel(raw), [raw]);
  const value = useMemo(() => ({ raw, model, actions, basePath }), [raw, model, actions, basePath]);
  return <UgcCtx value={value}>{children}</UgcCtx>;
}

export function useUgc(): Ctx {
  const ctx = use(UgcCtx);
  if (!ctx) throw new Error("useUgc outside UgcProvider");
  return ctx;
}
