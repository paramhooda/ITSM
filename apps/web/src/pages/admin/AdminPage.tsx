import { lazy, Suspense, type ComponentType } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import type { Permission } from '@itsm/shared';
import { LoadingBlock } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { AdminLayout, NotAllowed } from '@/components/admin/AdminLayout';

const page = (loader: () => Promise<{ default: ComponentType }>) => lazy(loader);

const OverviewPage = page(() => import('./OverviewPage'));
const OptionsPage = page(() => import('./OptionsPage'));
const PriorityMatrixPage = page(() => import('./PriorityMatrixPage'));
const CustomFieldsPage = page(() => import('./CustomFieldsPage'));
const SlaPoliciesPage = page(() => import('./SlaPoliciesPage'));
const ServicesPage = page(() => import('./ServicesPage'));
/** Old `/admin/sla/:id` links open the policy in the list's editor drawer. */
function SlaRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/admin/sla?edit=${id}` : '/admin/sla'} replace />;
}
const CalendarsPage = page(() => import('./CalendarsPage'));
const HolidaysPage = page(() => import('./HolidaysPage'));
const AssignmentRulesPage = page(() => import('./AssignmentRulesPage'));
const EscalationRulesPage = page(() => import('./EscalationRulesPage'));
const NotificationTemplatesPage = page(() => import('./NotificationTemplatesPage'));
const NotificationRulesPage = page(() => import('./NotificationRulesPage'));
const ApprovalsPage = page(() => import('./ApprovalsPage'));
const ChangeTemplatesPage = page(() => import('./ChangeTemplatesPage'));
const ChangeRiskQuestionsPage = page(() => import('./ChangeRiskQuestionsPage'));
const ChangeBlackoutsPage = page(() => import('./ChangeBlackoutsPage'));
const CatalogPage = page(() => import('./CatalogPage'));
const SurveysPage = page(() => import('./SurveysPage'));
const CiTypesPage = page(() => import('./CiTypesPage'));
const RelationshipTypesPage = page(() => import('./RelationshipTypesPage'));
const UsersPage = page(() => import('./UsersPage'));
const RolesPage = page(() => import('./RolesPage'));
const TeamsPage = page(() => import('./TeamsPage'));
const ApiKeysPage = page(() => import('./ApiKeysPage'));
const SettingsPage = page(() => import('./SettingsPage'));
const AiPage = page(() => import('./AiPage'));
const OutboxPage = page(() => import('./OutboxPage'));
const WhatsAppPage = page(() => import('./WhatsAppPage'));
const AuditPage = page(() => import('./AuditPage'));
const IntegrationsPage = page(() => import('@/pages/integrations/IntegrationsPage'));

const CONFIG: Permission[] = ['admin:config'];
const USERS: Permission[] = ['admin:users'];

function Guarded({ perm, children }: { perm?: Permission[]; children: React.ReactNode }) {
  const can = useAuthStore((s) => s.can);
  if (perm && !can(...perm)) return <NotAllowed />;
  return <>{children}</>;
}

/** Administration area: left sub-navigation + routed content pane. */
export default function AdminPage() {
  return (
    <AdminLayout>
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="options/:type?" element={<Guarded perm={CONFIG}><OptionsPage /></Guarded>} />
          <Route path="priority-matrix" element={<Guarded perm={CONFIG}><PriorityMatrixPage /></Guarded>} />
          <Route path="custom-fields" element={<Guarded perm={CONFIG}><CustomFieldsPage /></Guarded>} />
          <Route path="services" element={<Guarded perm={['services:manage']}><ServicesPage /></Guarded>} />
          <Route path="sla" element={<Guarded perm={CONFIG}><SlaPoliciesPage /></Guarded>} />
          <Route path="sla/:id" element={<SlaRedirect />} />
          <Route path="calendars" element={<Guarded perm={CONFIG}><CalendarsPage /></Guarded>} />
          <Route path="holidays" element={<Guarded perm={CONFIG}><HolidaysPage /></Guarded>} />
          <Route path="assignment-rules" element={<Guarded perm={CONFIG}><AssignmentRulesPage /></Guarded>} />
          <Route path="escalation-rules" element={<Guarded perm={CONFIG}><EscalationRulesPage /></Guarded>} />
          <Route path="notifications/templates" element={<Guarded perm={CONFIG}><NotificationTemplatesPage /></Guarded>} />
          <Route path="notifications/rules" element={<Guarded perm={CONFIG}><NotificationRulesPage /></Guarded>} />
          <Route path="approvals" element={<Guarded perm={CONFIG}><ApprovalsPage /></Guarded>} />
          <Route path="change-templates" element={<Guarded perm={CONFIG}><ChangeTemplatesPage /></Guarded>} />
          <Route path="change-risk-questions" element={<Guarded perm={CONFIG}><ChangeRiskQuestionsPage /></Guarded>} />
          <Route path="change-blackouts" element={<Guarded perm={CONFIG}><ChangeBlackoutsPage /></Guarded>} />
          <Route path="catalog" element={<Guarded perm={CONFIG}><CatalogPage /></Guarded>} />
          <Route path="surveys" element={<Guarded perm={['surveys:manage', 'admin:config']}><SurveysPage /></Guarded>} />
          <Route path="ci-types" element={<Guarded perm={CONFIG}><CiTypesPage /></Guarded>} />
          <Route path="relationship-types" element={<Guarded perm={CONFIG}><RelationshipTypesPage /></Guarded>} />
          <Route path="users" element={<Guarded perm={USERS}><UsersPage /></Guarded>} />
          <Route path="roles" element={<Guarded perm={USERS}><RolesPage /></Guarded>} />
          <Route path="teams" element={<Guarded perm={USERS}><TeamsPage /></Guarded>} />
          <Route path="api-keys" element={<Guarded perm={['integrations:manage']}><ApiKeysPage /></Guarded>} />
          <Route path="settings" element={<Guarded perm={['admin:system', 'admin:config']}><SettingsPage /></Guarded>} />
          <Route path="ai" element={<Guarded perm={['admin:system', 'admin:config']}><AiPage /></Guarded>} />
          <Route path="outbox" element={<Guarded perm={['admin:system', 'admin:config']}><OutboxPage /></Guarded>} />
          <Route path="whatsapp" element={<Guarded perm={['admin:system', 'admin:config']}><WhatsAppPage /></Guarded>} />
          <Route path="audit" element={<Guarded perm={['admin:audit']}><AuditPage /></Guarded>} />
          <Route path="integrations" element={<Guarded perm={['integrations:events', 'integrations:manage']}><IntegrationsPage /></Guarded>} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Suspense>
    </AdminLayout>
  );
}
