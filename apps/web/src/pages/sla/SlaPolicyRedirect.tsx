import { Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { slaAdminPath } from '@/components/sla/api';

/**
 * SLA policies are edited in Administration now. `/sla/new` and `/sla/:id`
 * open the admin drawer; readers without admin:config land on the Service
 * levels page with that policy expanded.
 */
export default function SlaPolicyRedirect() {
  const { id = '' } = useParams();
  const can = useAuthStore((s) => s.can);
  const isNew = !id || id === 'new';
  if (can('admin:config')) return <Navigate to={isNew ? slaAdminPath(null) : slaAdminPath(id)} replace />;
  return <Navigate to={isNew ? '/sla' : `/sla?policy=${id}`} replace />;
}
