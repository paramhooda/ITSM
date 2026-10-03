import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { matchRoute } from '@itsm/shared';
import { useUiStore } from '@/stores/ui';

/**
 * Publishes the current page to the assistant: the route from the application
 * map, its parameters and the query filters the page understands (nothing
 * else from the URL). Mounted once per shell, inside the router.
 */
export function PageContextSync() {
  const { pathname, search } = useLocation();
  const setAssistantPage = useUiStore((s) => s.setAssistantPage);
  useEffect(() => {
    const hit = matchRoute(pathname);
    const query: Record<string, string> = {};
    if (hit) {
      const sp = new URLSearchParams(search);
      for (const k of hit.page.filters ?? []) {
        const v = sp.get(k);
        if (v) query[k] = v.slice(0, 200);
      }
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(hit?.params ?? {})) params[k] = v.slice(0, 120);
    setAssistantPage({ pathname: pathname.slice(0, 300), route: hit?.page.route, params, query });
    return () => setAssistantPage(null);
  }, [pathname, search, setAssistantPage]);
  return null;
}
