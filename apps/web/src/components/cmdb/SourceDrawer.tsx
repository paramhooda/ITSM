import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { post, patch } from '@/api/client';
import { Button, Select, Drawer, Field, Input, Textarea, Checkbox } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useSites, errorMessage, CRON_PRESETS } from '@/components/cmdb/hooks';
import type { DiscoverySource as Source } from './api';

const DEFAULT_PORTS = '22, 80, 443, 161, 3389, 445, 8443';

const emptyForm = () => ({ customerId: '', siteId: '', name: '', sourceType: 'network_scan', subnets: '', version: '2c' as '2c' | '3', communities: [''], v3: { username: '', authProtocol: 'sha', authKey: '', privProtocol: 'aes', privKey: '' }, ports: DEFAULT_PORTS, timeoutMs: '1500', concurrency: '64', maxHosts: '2048', dnsResolve: true, snmpAlways: true, scheduleCron: '', autoApply: false, isActive: true });
type Form = ReturnType<typeof emptyForm>;

function toForm(s: Source): Form {
  return { customerId: s.customerId, siteId: s.siteId ?? '', name: s.name, sourceType: s.sourceType, subnets: (s.config.subnets ?? []).join('\n'), version: s.config.snmp?.version ?? '2c', communities: s.config.snmp?.communities?.length ? [...s.config.snmp.communities] : [''], v3: { username: s.config.snmp?.v3?.username ?? '', authProtocol: s.config.snmp?.v3?.authProtocol ?? 'sha', authKey: s.config.snmp?.v3?.authKey ?? '', privProtocol: s.config.snmp?.v3?.privProtocol ?? 'aes', privKey: s.config.snmp?.v3?.privKey ?? '' }, ports: (s.config.ports ?? []).join(', ') || DEFAULT_PORTS, timeoutMs: String(s.config.timeoutMs ?? 1500), concurrency: String(s.config.concurrency ?? 64), maxHosts: String(s.config.maxHosts ?? 2048), dnsResolve: s.config.dnsResolve ?? false, snmpAlways: s.config.snmpAlways ?? true, scheduleCron: s.scheduleCron ?? '', autoApply: s.autoApply, isActive: s.isActive };
}

export function SourceDrawer({ open, onClose, source, providers }: { open: boolean; onClose: () => void; source?: Source | null; providers: { type: string; label: string }[] }) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const [f, setF] = useState<Form>(emptyForm());
  const sites = useSites(f.customerId);
  useEffect(() => {
    if (open) setF(source ? toForm(source) : emptyForm());
  }, [open, source]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const config = {
        subnets: f.subnets.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
        snmp: { version: f.version, communities: f.communities.map((c) => c.trim()).filter(Boolean), ...(f.version === '3' ? { v3: { username: f.v3.username || undefined, authProtocol: f.v3.authProtocol, authKey: f.v3.authKey || undefined, privProtocol: f.v3.privProtocol, privKey: f.v3.privKey || undefined } } : {}) },
        ports: f.ports.split(/[\s,;]+/).map(Number).filter((n) => n > 0 && n < 65536),
        timeoutMs: Number(f.timeoutMs) || 1500,
        concurrency: Number(f.concurrency) || 64,
        maxHosts: Number(f.maxHosts) || 2048,
        dnsResolve: f.dnsResolve,
        snmpAlways: f.snmpAlways,
      };
      const body = { siteId: f.siteId || null, name: f.name, sourceType: f.sourceType, config, scheduleCron: f.scheduleCron || null, autoApply: f.autoApply, isActive: f.isActive };
      return source ? patch<Source>(`/discovery/sources/${source.id}`, body) : post<Source>('/discovery/sources', { ...body, customerId: f.customerId });
    },
    onSuccess: () => {
      toast.success(source ? 'Source updated' : 'Source created');
      qc.invalidateQueries({ queryKey: ['discovery'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const preset = CRON_PRESETS.find((p) => p.value === f.scheduleCron)?.value ?? (f.scheduleCron ? 'custom' : '');
  return (
    <Drawer open={open} onClose={onClose} title={source ? `Edit ${source.name}` : 'New discovery source'} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.name || !f.customerId || !f.subnets.trim()} onClick={() => save.mutate()}>{source ? 'Save changes' : 'Create source'}</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer" required>
          <Select value={f.customerId} disabled={!!source} onChange={(e) => { set('customerId', e.target.value); set('siteId', ''); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        </Field>
        <Field label="Site" hint="Discovered CIs are created at this site.">
          <Select value={f.siteId} onChange={(e) => set('siteId', e.target.value)} placeholder="—" options={(sites.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
        </Field>
        <Field label="Name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="HQ server VLANs" /></Field>
        <Field label="Source type"><Select value={f.sourceType} onChange={(e) => set('sourceType', e.target.value)} options={providers.map((p) => ({ value: p.type, label: p.label }))} /></Field>
        <Field label="Targets" required hint="One per line: CIDR (10.0.0.0/24), range (10.0.0.1-10.0.0.50) or single IP." className="sm:col-span-2">
          <Textarea className="font-mono text-xs min-h-[90px]" value={f.subnets} onChange={(e) => set('subnets', e.target.value)} placeholder={'10.0.0.0/24\n10.0.1.1-10.0.1.100'} />
        </Field>
        <Field label="SNMP version"><Select value={f.version} onChange={(e) => set('version', e.target.value as '2c' | '3')} options={[{ value: '2c', label: 'v2c (community)' }, { value: '3', label: 'v3 (user security)' }]} /></Field>
        <Field label="Ports (TCP)" hint="Comma separated."><Input className="font-mono text-xs" value={f.ports} onChange={(e) => set('ports', e.target.value)} /></Field>
        {f.version === '2c' ? (
          <Field label="SNMP communities" hint="Tried in order; stored encrypted. Leave as ******** to keep an existing value." className="sm:col-span-2">
            <div className="flex flex-col gap-1.5">
              {f.communities.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <Input type="password" autoComplete="new-password" value={c} onChange={(e) => set('communities', f.communities.map((x, j) => (j === i ? e.target.value : x)))} placeholder="public" />
                  <Button variant="ghost" size="icon" onClick={() => set('communities', f.communities.filter((_, j) => j !== i))} disabled={f.communities.length === 1} aria-label="Remove"><Minus className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" className="self-start" icon={<Plus className="h-4 w-4" />} onClick={() => set('communities', [...f.communities, ''])} disabled={f.communities.length >= 10}>Add community</Button>
            </div>
          </Field>
        ) : (
          <>
            <Field label="v3 user" required><Input value={f.v3.username} onChange={(e) => set('v3', { ...f.v3, username: e.target.value })} /></Field>
            <div />
            <Field label="Auth protocol"><Select value={f.v3.authProtocol} onChange={(e) => set('v3', { ...f.v3, authProtocol: e.target.value })} options={['none', 'md5', 'sha', 'sha256', 'sha512'].map((v) => ({ value: v, label: v.toUpperCase() }))} /></Field>
            <Field label="Auth key"><Input type="password" autoComplete="new-password" value={f.v3.authKey} onChange={(e) => set('v3', { ...f.v3, authKey: e.target.value })} /></Field>
            <Field label="Privacy protocol"><Select value={f.v3.privProtocol} onChange={(e) => set('v3', { ...f.v3, privProtocol: e.target.value })} options={['none', 'des', 'aes', 'aes256'].map((v) => ({ value: v, label: v.toUpperCase() }))} /></Field>
            <Field label="Privacy key"><Input type="password" autoComplete="new-password" value={f.v3.privKey} onChange={(e) => set('v3', { ...f.v3, privKey: e.target.value })} /></Field>
          </>
        )}
        <Field label="Timeout (ms)"><Input type="number" min={200} max={10000} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} /></Field>
        <Field label="Concurrency"><Input type="number" min={1} max={256} value={f.concurrency} onChange={(e) => set('concurrency', e.target.value)} /></Field>
        <Field label="Max hosts per run"><Input type="number" min={1} max={65536} value={f.maxHosts} onChange={(e) => set('maxHosts', e.target.value)} /></Field>
        <div className="flex flex-col gap-2 justify-end pb-1">
          <Checkbox label="Resolve hostnames via reverse DNS" checked={f.dnsResolve} onChange={(e) => set('dnsResolve', e.target.checked)} />
          <Checkbox label="Always try SNMP (not only when a port answers)" checked={f.snmpAlways} onChange={(e) => set('snmpAlways', e.target.checked)} />
        </div>
        <Field label="Schedule"><Select value={preset} onChange={(e) => set('scheduleCron', e.target.value === 'custom' ? f.scheduleCron || '0 2 * * *' : e.target.value)} options={[...CRON_PRESETS, { value: 'custom', label: 'Custom cron…' }]} /></Field>
        <Field label="Cron expression" hint="minute hour day month weekday (UTC)"><Input className="font-mono text-xs" value={f.scheduleCron} onChange={(e) => set('scheduleCron', e.target.value)} placeholder="0 2 * * *" /></Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Checkbox label="Auto-apply new and changed findings (create/update CIs without review)" checked={f.autoApply} onChange={(e) => set('autoApply', e.target.checked)} />
          <Checkbox label="Active (scheduled runs enabled)" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        </div>
      </div>
    </Drawer>
  );
}
