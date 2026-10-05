import type { SurveyEmbed } from '@/components/surveys/api';
import type { KnownErrorRow } from '@/components/known-errors/api';
import { TICKET_TYPE_COLORS } from '@/lib/statusColors';
import type { Conflict } from '@/components/changes/api';
/** API shapes of the tickets module (kept in sync with apps/api/src/modules/tickets). */
export type TicketType = 'incident' | 'request' | 'problem' | 'change';
export type ScopeStatus = 'in_scope' | 'out_of_scope' | 'unknown';
export type SlaState = 'running' | 'paused' | 'met' | 'breached' | 'cancelled';

export interface OptionLabel {
  id: string;
  key: string;
  label: string;
  color: string | null;
  category?: string | null;
  level?: number | null;
  domain?: string;
}

export interface SlaCompact {
  metric: string;
  state: SlaState;
  dueAt: string;
  pctConsumed: number;
  remainingMinutes: number;
  breached: boolean;
  paused: boolean;
}

export interface SlaMetricSummary {
  id: string;
  metric: string;
  label: string;
  state: SlaState;
  policyId: string | null;
  targetMinutes: number;
  warnPct: number;
  calendarTime: boolean;
  startedAt: string;
  dueAt: string;
  pausedAt: string | null;
  pausedMinutes: number;
  elapsedMinutes: number;
  remainingMinutes: number;
  pctConsumed: number;
  breached: boolean;
  warned: boolean;
  completedAt: string | null;
  breachedAt: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'angry';
/** Breach forecast written by the risk job (staff only; null until scored or when the clocks are done). */
export interface BreachRisk {
  level: RiskLevel;
  score: number;
  reason: string;
  at?: string | null;
}
/** Mood of the customer's last comment (staff only). */
export interface SentimentFlag {
  sentiment: Sentiment;
  at: string | null;
}

export interface TicketListRow {
  id: string;
  number: string;
  type: TicketType;
  typeLabel: string;
  title: string;
  customerId: string;
  customerName: string | null;
  siteId: string | null;
  siteName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  status: OptionLabel;
  priority: OptionLabel | null;
  categoryId: string | null;
  categoryLabel: string | null;
  domain: string;
  scopeStatus: ScopeStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedTeamId: string | null;
  teamName: string | null;
  isMajor: boolean;
  escalationLevel: number;
  tags: string[];
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  approvalStatus: string | null;
  sla: SlaCompact | null;
  breachRisk: BreachRisk | null;
  lastSentiment: SentimentFlag | null;
  /** A problem flagged as a known error. */
  isKnownError?: boolean;
  /** The customer's satisfaction rating once answered, and the state of the ticket's survey. */
  csatRating?: number | null;
  surveyStatus?: string | null;
}

export interface TicketStats {
  byStatusCategory: Record<string, number>;
  byType: Record<string, number>;
  /** Rows matching the current filters. */
  total: number;
  byPriority: { id: string | null; label: string; color: string | null; level: number | null; count: number }[];
  byStatus: { id: string | null; label: string; color: string | null; category: string | null; count: number }[];
  byTeam: { id: string | null; label: string; count: number; breached: number }[];
  /** Daily opened / resolved for the filtered set (last 14 days, or the created range). */
  series: { day: string; opened: number; resolved: number }[];
  open: number;
  breached: number;
  atRisk: number;
  unassigned: number;
  dueToday: number;
  overdue: number;
  mine: number;
  major: number;
  createdToday: number;
  resolvedToday: number;
  pendingApprovals: number;
  /** Open tickets the risk job rates as likely to breach. */
  highRisk: number;
  /** Open tickets whose customer sounded negative or angry in the last comment. */
  unhappy: number;
  /** Problems flagged as known errors in the filtered set. */
  knownErrors?: number;
}

export interface UserLite {
  id: string;
  name: string;
  email?: string;
  userType?: string;
}

export interface LinkedTicket {
  id: string;
  linkType: string;
  direction: 'inbound' | 'outbound';
  createdAt: string;
  ticket: { id: string; number: string; title: string; type: TicketType; status: OptionLabel | null; priority: OptionLabel | null; /** A problem flagged as a known error. */ isKnownError?: boolean };
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  assigneeId: string | null;
  teamId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  sortOrder: number;
}

/** An approval step in the signed-in user's inbox, with the ticket it belongs to. */
export interface MyApproval extends Approval {
  ticketId: string;
  customerId: string;
  ticket: { id: string; number: string; title: string; type: TicketType; customerId: string; customerName: string | null; priority: OptionLabel | null; status: OptionLabel | null; requesterName: string | null; createdAt: string };
}

export interface Approval {
  id: string;
  step: number;
  stepName: string | null;
  approverUserId: string | null;
  approverRoleKey: string | null;
  approverTeamId: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
  approverUser?: UserLite | null;
  approverTeam?: { id: string; name: string } | null;
  approverRole?: { key: string; name: string } | null;
  decidedByUser?: UserLite | null;
  canDecide?: boolean;
}

export interface ProblemDetails {
  symptoms: string | null;
  investigation: string | null;
  rootCause: string | null;
  workaround: string | null;
  isKnownError: boolean;
  permanentFix: string | null;
  kbArticleId: string | null;
  impactSummary: string | null;
  /** Known error database fields (null until the problem is flagged as a known error). */
  keStatus?: string | null;
  keStatusAt?: string | null;
  keIdentifiedAt?: string | null;
  fixChangeId?: string | null;
  portalVisible?: boolean;
  customerSummary?: string | null;
  customerWorkaround?: string | null;
  publishedAt?: string | null;
}

export interface ChangeDetails {
  changeType: string;
  riskId: string | null;
  risk?: OptionLabel | null;
  riskAssessment: string | null;
  impactAssessment: string | null;
  justification: string | null;
  implementationPlan: string | null;
  testPlan: string | null;
  backoutPlan: string | null;
  communicationPlan: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  downtimeExpectedMinutes: number | null;
  cabNotes: string | null;
  implementationNotes: string | null;
  pirNotes: string | null;
  pirOutcome: string | null;
  reviewedAt: string | null;
  /** The risk questionnaire: question key → option key, the score (0-100) and the level it produced. */
  riskAnswers?: Record<string, string> | null;
  riskScore?: number | null;
  riskLevel?: 'low' | 'medium' | 'high' | null;
  templateId?: string | null;
  cabMeetingId?: string | null;
  windowReminderAt?: string | null;
  /** Staff-only extras: the live clashes of the window, the template it came from and its latest CAB slot. */
  conflicts?: Conflict[];
  template?: { id: string; key: string; name: string } | null;
  cabMeeting?: { id: string; title: string; scheduledAt: string; status: string; decision: string; notes: string | null; decidedAt: string | null } | null;
}

export interface TicketPermissions {
  update: boolean;
  assign: boolean;
  resolve: boolean;
  close: boolean;
  reopen: boolean;
  cancel: boolean;
  comment: boolean;
  workNote: boolean;
  time: boolean;
  scope: boolean;
  escalate: boolean;
  problem: boolean;
  change: boolean;
  /** The risk questionnaire: a change manager, or the raiser or assignee holding tickets:update. */
  assessRisk: boolean;
  approve: boolean;
  tasks: boolean;
  links: boolean;
  watch: boolean;
  /** Declare, demote and run the major incident (tickets:major, incidents only). */
  major: boolean;
  /** Publish the problem's customer wording to the portal (kedb:publish). */
  publish?: boolean;
  /** Send or re-send the satisfaction survey by hand (surveys:manage). */
  survey?: boolean;
}

export type MajorStatus = 'active' | 'resolved' | 'review_done' | 'demoted';

/** The slice of the major incident record the ticket payload carries. */
export interface MajorSummary {
  status: MajorStatus;
  declaredAt: string;
  resolvedAt: string | null;
  lastUpdateAt: string | null;
  nextUpdateDueAt: string | null;
  updateIntervalMinutes: number;
  commanderUserId: string | null;
  commsLeadUserId: string | null;
  bridgeUrl: string | null;
  portalBanner: boolean;
  pirCompletedAt: string | null;
}

export interface PirAction {
  id: string;
  text: string;
  ownerId?: string | null;
  ownerName?: string | null;
  dueAt?: string | null;
  done?: boolean;
}

export interface MajorRecord extends MajorSummary {
  ticketId: string;
  customerId: string;
  declaredBy: string | null;
  declaredByName: string | null;
  declaredAt: string;
  demotedAt: string | null;
  bridgeNotes: string | null;
  commanderName: string | null;
  commsLeadName: string | null;
  lastReminderAt: string | null;
  pirWhatHappened: string | null;
  pirImpact: string | null;
  pirRootCause: string | null;
  pirActions: PirAction[];
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MajorAudience {
  requester?: boolean;
  watchers?: boolean;
  customerContacts?: boolean;
  accountManager?: boolean;
  assignee?: boolean;
  team?: boolean;
  manager?: boolean;
}

export interface MajorUpdate {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  kind: 'stakeholder' | 'internal';
  body: string;
  audience: MajorAudience;
  channels: string[];
  portalBanner: boolean;
  sentCount: number;
  createdAt: string;
}

export interface MajorChild {
  id: string;
  number: string;
  title: string;
  status: OptionLabel | null;
  priority: OptionLabel | null;
  createdAt: string;
  linkId: string;
}

export interface MajorDetail {
  record: MajorRecord | null;
  updates: MajorUpdate[];
  children: MajorChild[];
}

export interface MajorListRow {
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string;
  status: MajorStatus;
  ticketStatus: OptionLabel | null;
  priority: OptionLabel | null;
  declaredAt: string;
  resolvedAt: string | null;
  lastUpdateAt: string | null;
  nextUpdateDueAt: string | null;
  bridgeUrl: string | null;
  portalBanner: boolean;
  commanderName: string | null;
  commsLeadName: string | null;
  updatesCount: number;
  childrenCount: number;
  overdue: boolean;
}

export interface MajorList {
  items: MajorListRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: { active: number; overdue: number; awaitingReview: number; resolved30d: number };
}

export const MAJOR_STATUS_LABELS: Record<MajorStatus, string> = { active: 'Active', resolved: 'Resolved · review pending', review_done: 'Review complete', demoted: 'Demoted' };

export interface TicketDetail {
  id: string;
  number: string;
  type: TicketType;
  typeLabel: string;
  customerId: string;
  siteId: string | null;
  contractId: string | null;
  serviceId: string | null;
  title: string;
  description: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  priorityId: string | null;
  impactId: string | null;
  urgencyId: string | null;
  statusId: string;
  sourceId: string | null;
  domain: string;
  assignedTeamId: string | null;
  assigneeId: string | null;
  requesterUserId: string | null;
  requesterContactId: string | null;
  primaryCiId: string | null;
  primaryAssetId: string | null;
  scopeStatus: ScopeStatus;
  scopeContractId: string | null;
  scopeNote: string | null;
  scopeClassifiedBy: string | null;
  scopeClassifiedAt: string | null;
  slaPolicyId: string | null;
  catalogItemId: string | null;
  formData: Record<string, unknown>;
  parentTicketId: string | null;
  securitySeverityId: string | null;
  resolutionNotes: string | null;
  approvalStatus: string | null;
  firstResponseAt: string | null;
  acknowledgedAt: string | null;
  restoredAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
  reopenCount: number;
  escalationLevel: number;
  isMajor: boolean;
  externalRef?: string | null;
  tags: string[];
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  status: OptionLabel | null;
  priority: OptionLabel | null;
  impact: OptionLabel | null;
  urgency: OptionLabel | null;
  category: OptionLabel | null;
  subcategory: OptionLabel | null;
  source: OptionLabel | null;
  securitySeverity: OptionLabel | null;
  resolutionCode: OptionLabel | null;
  closureCode: OptionLabel | null;
  customer: { id: string; name: string; code: string } | null;
  site: { id: string; name: string; code: string } | null;
  service: { id: string; name: string; key: string } | null;
  contract: { id: string; number: string; name: string; slaPolicyId: string | null; slaPolicyName: string | null; status: string; endDate: string } | null;
  scopeContract: { id: string; number: string; name: string } | null;
  scopeClassifiedByUser: UserLite | null;
  assignee: UserLite | null;
  team: { id: string; name: string; key: string; managerUserId: string | null } | null;
  requester: UserLite | null;
  requesterContact: { id: string; name: string; email: string | null; phone: string | null } | null;
  createdByUser: UserLite | null;
  catalogItem: { id: string; name: string; formSchema: Record<string, unknown>[]; fulfilmentInstructions: string | null } | null;
  parent: { id: string; number: string; title: string } | null;
  slaPolicy: { id: string; name: string | null } | null;
  slas: SlaMetricSummary[];
  sla: SlaCompact | null;
  breachRisk?: BreachRisk | null;
  lastSentiment?: SentimentFlag | null;
  watchers: UserLite[];
  isWatching: boolean;
  cis: { id: string; name: string; hostname: string | null; ipAddress: string | null; status: string; role: string; typeId: string }[];
  assets: { id: string; tag: string; name: string; serialNumber: string | null }[];
  links: LinkedTicket[];
  tasks: Task[];
  approvals: Approval[];
  problem: ProblemDetails | null;
  change: ChangeDetails | null;
  escalations: { id: string; level: number; reason: string; occurredAt: string }[];
  statuses: OptionLabel[];
  permissions: TicketPermissions;
  /** Present once the ticket has ever been declared a major incident (status says whether it still is). */
  major?: MajorSummary | null;
  /** Incidents only: the linked known error, or the best matches while nothing is linked; null without kedb:read. */
  knownError?: { linked: KnownErrorRow | null; suggestions: KnownErrorRow[] } | null;
  /** The satisfaction survey of the ticket (staff see the recipient and the send history), or why none was sent. */
  survey?: SurveyEmbed | null;
}

export interface TimelineEntry {
  id: string;
  kind: 'comment' | 'activity';
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  type: string;
  body?: string;
  summary?: string;
  data?: Record<string, unknown>;
  isInternal: boolean;
  customerVisible: boolean;
  minutesSpent?: number | null;
  editedAt?: string | null;
  source?: string;
}

export interface TimeEntry {
  id: string;
  userId: string;
  userName?: string | null;
  minutes: number;
  description: string | null;
  workType: string;
  billable: boolean;
  startedAt: string | null;
  entitlementId: string | null;
  createdAt: string;
}

export interface SimilarTicket {
  id: string;
  number: string;
  title: string;
  type: TicketType;
  customerName: string | null;
  sameCustomer: boolean;
  status: OptionLabel | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
}

export interface SavedView {
  id: string;
  name: string;
  entity: string;
  filters: Record<string, unknown>;
  columns: string[];
  sort: string | null;
  isShared: boolean;
  isDefault: boolean;
  isOwner: boolean;
}

export interface CatalogItem {
  id: string;
  key?: string;
  name: string;
  description?: string | null;
  formSchema: CatalogField[];
  categoryId?: string | null;
  ticketCategoryId?: string | null;
  defaultPriorityId?: string | null;
  serviceId?: string | null;
  approvalWorkflowId?: string | null;
}

export interface CatalogField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'date' | 'boolean' | 'email' | string;
  required?: boolean;
  options?: (string | { value: string; label: string })[];
  helpText?: string;
  placeholder?: string;
}

export const TYPE_LABELS: Record<TicketType, string> = { incident: 'Incident', request: 'Request', problem: 'Problem', change: 'Change' };
export const TYPE_COLORS: Record<TicketType, string> = TICKET_TYPE_COLORS as Record<TicketType, string>;
export const LINK_TYPE_LABELS: Record<string, string> = { related: 'Related to', duplicate_of: 'Duplicate of', caused_by: 'Caused by', blocks: 'Blocks', child_of: 'Child of', problem_of: 'Problem', change_for: 'Change for', resolved_by: 'Resolved by' };
