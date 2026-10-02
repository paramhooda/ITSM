import { Badge } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { Server, Box, Layers, Network, Route, Shield, Radio, Wifi, Scale, HardDrive, GitBranch, Archive, ShieldCheck, Cloud, Cog, BatteryCharging, Laptop, Printer, Phone, Cpu, Briefcase, AppWindow, Database, type LucideIcon } from 'lucide-react';

/** lucide icon per ci_types.icon value (seeded names). */
export const CI_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase, 'app-window': AppWindow, database: Database, server: Server, box: Box, layers: Layers, network: Network, route: Route, shield: Shield, radio: Radio, wifi: Wifi, scale: Scale, 'hard-drive': HardDrive, 'git-branch': GitBranch, archive: Archive, 'shield-check': ShieldCheck, cloud: Cloud, 'cloud-cog': Cog, 'battery-charging': BatteryCharging, laptop: Laptop, printer: Printer, phone: Phone, cpu: Cpu,
};

export function CiTypeIcon({ icon, className = 'h-3.5 w-3.5' }: { icon?: string | null; className?: string }) {
  const Icon = (icon && CI_ICONS[icon]) || Box;
  return <Icon className={className} />;
}

/** Badge for a CI type: accepts either a type key (resolved via lookups) or explicit name/colour/icon. */
export function CiTypeBadge({ typeKey, name, color, icon, className }: { typeKey?: string | null; name?: string | null; color?: string | null; icon?: string | null; className?: string }) {
  const { lookups } = useLookups();
  const t = typeKey ? lookups?.ciTypes.find((x) => x.key === typeKey) : undefined;
  const label = name ?? t?.name ?? typeKey ?? 'Unknown';
  return (
    <Badge color={color ?? t?.color ?? 'slate'} className={className}>
      <CiTypeIcon icon={icon ?? t?.icon} />
      {label}
    </Badge>
  );
}

export const CI_STATUS_COLORS: Record<string, string> = { planned: 'blue', active: 'green', inactive: 'gray', maintenance: 'amber', retired: 'slate' };
export const CRITICALITY_COLORS: Record<string, string> = { critical: 'red', high: 'orange', medium: 'amber', low: 'slate' };
export const ENVIRONMENTS = ['production', 'staging', 'test', 'development', 'dr', 'other'];
export const CRITICALITIES = ['critical', 'high', 'medium', 'low'];
export const CI_STATUSES = ['planned', 'active', 'inactive', 'maintenance', 'retired'];

export function CiStatusBadge({ status }: { status?: string | null }) {
  return <Badge color={CI_STATUS_COLORS[status ?? ''] ?? 'slate'} dot>{status ?? '—'}</Badge>;
}
export function CriticalityBadge({ value }: { value?: string | null }) {
  return <Badge color={CRITICALITY_COLORS[value ?? ''] ?? 'slate'}>{value ?? '—'}</Badge>;
}
