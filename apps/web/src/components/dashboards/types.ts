export interface SlaCompact {
  metric: string;
  state: string;
  dueAt: string;
  pctConsumed: number;
  remainingMinutes: number;
  breached: boolean;
  paused: boolean;
}

export interface TicketRow {
  id: string;
  number: string;
  type: string;
  title: string;
  customer_id: string;
  customer_name: string | null;
  priority: string | null;
  priority_color: string | null;
  priority_level: number | null;
  status: string | null;
  status_color: string | null;
  status_category: string | null;
  category: string | null;
  assignee_id: string | null;
  assignee: string | null;
  team: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  last_activity_at: string;
  escalation_level: number;
  is_major: boolean;
  scope_status: string;
  sla?: SlaCompact | null;
  ci_name?: string | null;
  ci_id?: string | null;
  severity?: string | null;
  severity_color?: string | null;
  due_at?: string | null;
  mttr_minutes?: number | null;
  site_name?: string | null;
  status_key?: string | null;
  visit_number?: string | null;
  visit_id?: string | null;
  due_today?: boolean;
}

export interface Delta {
  current: number | null;
  previous: number | null;
  deltaPct: number | null;
}

export interface Breakdown {
  id?: string | null;
  label: string;
  key?: string | null;
  color?: string | null;
  level?: number;
  count: number;
  breached?: number;
}
