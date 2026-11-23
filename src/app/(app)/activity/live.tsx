"use client";

import { ActivityList, type ActivityListProps } from "@/components/activity/activity-list";
import { undoActivity } from "@/lib/activity/actions";

/** The Activity list on real data: pages through `listActivity` (the page's `load`), undoes with `undoActivity`. */
export function ActivityLive(props: Omit<ActivityListProps, "undo">) {
  return <ActivityList {...props} undo={undoActivity} />;
}
