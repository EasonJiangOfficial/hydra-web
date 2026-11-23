/** Database rows of 0040_planning.sql, as PostgREST returns them (hand-written until typegen lands). */

export interface PlanningStatusRow {
  id: string;
  label: string;
  color: string;
  position: number;
  is_done: boolean;
  created_at: string;
}

export interface PlanningGoalRow {
  id: string;
  title: string;
  notes: string;
  category: string | null;
  start_date: string | null;
  deadline: string | null;
  position: number;
  achieved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanningGoalMetricRow {
  id: string;
  goal_id: string;
  metric: string;
  target: number | string;
  param: string | null;
  position: number;
  created_at: string;
}

export interface PlanningGoalLinkRow {
  id: string;
  goal_id: string;
  url: string;
  title: string | null;
  position: number;
  created_at: string;
}

export interface PlanningTaskRow {
  id: string;
  title: string;
  notes: string;
  status_id: string;
  goal_id: string | null;
  category: string | null;
  due_date: string | null;
  position: number;
  alert_at: string | null;
  repeat_rule: string | null;
  repeat_series_id: string | null;
  repeat_period: string | null;
  repeat_anchor_day: number | null;
  repeat_since: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EventRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  category: string | null;
  repeat: string | null;
  notes: string;
  alert_at: string | null;
  google_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanningPropertyRow {
  id: string;
  name: string;
  type: "select" | "multi_select" | "number" | "text" | "checkbox" | "date" | "url";
  number_format: "number" | "percent" | "dollar";
  position: number;
  show_on_board: boolean;
  show_in_list: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlanningPropertyOptionRow {
  id: string;
  property_id: string;
  label: string;
  color: string;
  position: number;
  created_at: string;
}

/** 0118_planning_category_colors.sql. */
export interface PlanningCategoryColorRow {
  category: string;
  color: string;
  updated_at: string;
}

export interface PlanningTaskValueRow {
  task_id: string;
  property_id: string;
  text_value: string | null;
  number_value: number | string | null;
  date_value: string | null;
  bool_value: boolean | null;
  option_ids: string[] | null;
  updated_at: string;
}
