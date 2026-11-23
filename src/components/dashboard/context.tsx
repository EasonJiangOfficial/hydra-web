"use client";

import { createContext, useContext } from "react";
import type { DashboardData } from "./types";

const DataContext = createContext<DashboardData | null>(null);

/** The grid draws each block from a component with no props, so the cards read their data from here. */
export const DashboardProvider = DataContext.Provider;

export function useDashboard(): DashboardData {
  const data = useContext(DataContext);
  if (!data) throw new Error("useDashboard: no DashboardProvider above this card");
  return data;
}
