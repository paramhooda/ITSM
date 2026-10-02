import { Navigate, useParams, useLocation } from 'react-router-dom';

/** Old `/cmdb/:id` links now live under Configuration items. */
export default function CiRedirect() {
  const { id = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/cmdb/cis/${id}${search}`} replace />;
}
