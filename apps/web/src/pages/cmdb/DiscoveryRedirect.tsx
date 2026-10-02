import { Navigate, useLocation } from 'react-router-dom';

/** Discovery is a module of Configuration (CMDB) now. */
export default function DiscoveryRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/cmdb/discovery${search}`} replace />;
}
