import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Overview pages sit at the application root (/assets, /customers …) where the list used
 * to be. A link that still carries list filters (?expiring=warranty90, ?customerId=…) is
 * forwarded to the list module with the same query, so every old bookmark and
 * dashboard drill-down keeps working.
 */
export function useForwardListParams(listPath: string) {
  const { search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (search && search.length > 1) navigate(`${listPath}${search}`, { replace: true });
  }, [search, listPath, navigate]);
  return !!search && search.length > 1;
}
