import { Navigate, useLocation } from 'react-router-dom';

/** Monitoring & SIEM moved under Administration; forward old links with their query string. */
export default function IntegrationsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/admin/integrations${search}`} replace />;
}
