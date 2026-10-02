import { Link } from 'react-router-dom';
import { Plug, KeyRound, ArrowRight } from 'lucide-react';
import { SectionHeader } from '@/components/admin/AdminLayout';

export default function IntegrationsPage() {
  return (
    <div>
      <SectionHeader title="Integrations" description="Monitoring (PRTG), SIEM (FortiSIEM) and other event sources are configured in the Monitoring & SIEM area." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Link to="/integrations" className="card p-4 hover:border-brand-400 transition-colors">
          <div className="flex items-center gap-2 font-semibold text-[13px]"><Plug className="h-4 w-4 text-muted" /> Monitoring & SIEM integrations</div>
          <div className="text-[13px] text-muted mt-1">Create integrations, map events to customers and CIs, define correlation and auto-ticketing rules, and review incoming events.</div>
          <div className="inline-flex items-center gap-1 text-[13px] text-brand-600 mt-3">Open integrations <ArrowRight className="h-3.5 w-3.5" /></div>
        </Link>
        <Link to="/admin/api-keys" className="card p-4 hover:border-brand-400 transition-colors">
          <div className="flex items-center gap-2 font-semibold text-[13px]"><KeyRound className="h-4 w-4 text-muted" /> API keys</div>
          <div className="text-[13px] text-muted mt-1">Each integration authenticates with an API key scoped to a customer and a small permission set. Manage and revoke keys here.</div>
          <div className="inline-flex items-center gap-1 text-[13px] text-brand-600 mt-3">Manage API keys <ArrowRight className="h-3.5 w-3.5" /></div>
        </Link>
      </div>
    </div>
  );
}
