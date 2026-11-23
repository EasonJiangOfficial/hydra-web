"use client";

import { useState } from "react";
import { Bar, DetailDrawer, Input, Label, ListRow, MotionNumber, Pill, Seg, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";

const periods = [
  { value: "nov", label: "November", cents: 648000 },
  { value: "oct", label: "October", cents: 730000 },
  { value: "sep", label: "September", cents: 690000 },
];

/** MotionNumber tweening between fixture values. */
export function MotionNumberDemo() {
  const [period, setPeriod] = useState("nov");
  const cents = periods.find((p) => p.value === period)!.cents;
  return (
    <div className="flex flex-col gap-3">
      <Seg aria-label="Month" items={periods} value={period} onValueChange={setPeriod} />
      <MotionNumber value={cents} money={{ whole: true }} className="text-figure" />
    </div>
  );
}

/** The shared drawer, opened by `?task=`. */
export function TaskDrawerDemo() {
  return (
    <DetailDrawer param="task" label="Task">
      {(id) => (
        <div className="flex flex-col gap-5">
          <h2 className="text-section">Film three Wordwise hooks</h2>
          <div>
            <ListRow>
              <Label className="w-24">Status</Label>
              <Pill tone="strong">In progress</Pill>
            </ListRow>
            <ListRow>
              <Label className="w-24">Goal</Label>
              <span className="flex-1">Post 3 videos a day</span>
            </ListRow>
            <ListRow>
              <Label className="w-24">Due</Label>
              <span className="tabular-nums">Nov 24</span>
            </ListRow>
            <ListRow>
              <Label className="w-24">Progress</Label>
              <Bar value={0.66} className="flex-1" aria-label="Task progress" />
            </ListRow>
            <ListRow>
              <Label className="w-24">Task id</Label>
              <span className="tabular-nums">{id}</span>
            </ListRow>
          </div>
          <label className="flex flex-col gap-1.5">
            <Label>Notes</Label>
            <Input defaultValue="Hook A, B and C from the brief." />
          </label>
        </div>
      )}
    </DetailDrawer>
  );
}

/** Tabs and Seg inside the drawer (`?goal=`): their sliding underline and thumb must mount in a panel. */
export function TabsDrawerDemo() {
  return (
    <DetailDrawer param="goal" label="Goal">
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-4">
          <Seg aria-label="Range" items={periods} defaultValue="nov" className="self-start" />
          <p>Post 3 videos a day</p>
        </TabsContent>
        <TabsContent value="history">
          <p>12 of 30 days met</p>
        </TabsContent>
      </Tabs>
    </DetailDrawer>
  );
}
