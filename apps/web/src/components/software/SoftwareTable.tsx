import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import { DataTable, EmptyState, type Column } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { SourceBadge } from './SoftwareBits';
import { titleOf } from './api';

/** One installation as the CI and asset records carry it (`software` on GET /cmdb/cis/:id and /assets/:id). */
export interface HostSoftware {
  id: string;
  productId: string;
  publisher: string;
  name: string;
  versionFamily: string | null;
  version: string | null;
  edition: string | null;
  source: string;
  lastSeenAt: string | null;
  assignedUser: string | null;
}

/** The software recorded on one host, for the Software tab of CI and asset records. */
export function SoftwareTable({ rows, customerId }: { rows: HostSoftware[]; customerId?: string | null }) {
  const columns: Column<HostSoftware>[] = [
    { key: 'title', header: 'Title', render: (s) => <Link to={`/assets/software/titles/${s.productId}${customerId ? `?customerId=${customerId}` : ''}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{titleOf(s)}</Link> },
    { key: 'version', header: 'Version', width: '130px', render: (s) => <span className="font-mono text-xs">{s.version ?? '—'}</span> },
    { key: 'edition', header: 'Edition', width: '140px', render: (s) => s.edition ?? <span className="text-subtle">—</span> },
    { key: 'user', header: 'User', render: (s) => s.assignedUser ?? <span className="text-subtle">—</span> },
    { key: 'source', header: 'Source', width: '140px', render: (s) => <SourceBadge source={s.source} /> },
    { key: 'lastSeenAt', header: 'Last seen', width: '120px', render: (s) => <span className="text-muted">{s.lastSeenAt ? relativeTime(s.lastSeenAt) : '—'}</span> },
  ];
  return <DataTable columns={columns} rows={rows} dense empty={<EmptyState icon={<Package className="h-5 w-5" />} title="No software recorded on this host" description="Record installations by hand or import them from CSV under Assets → Software → Installations." />} />;
}
