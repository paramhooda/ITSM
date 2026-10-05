import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Copy, Eye, MoreHorizontal, Play, RotateCcw, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, ModuleNav, Card, Button, Badge, EmptyState, LoadingBlock, ErrorBlock, ConfirmDialog, Field, Input, Textarea, Select, Toggle } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { REPORT_MODULES } from '@/layouts/modules';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useCustomersLookup } from '@/hooks/useLookups';
import { REPORT_VISIBILITY_COLORS } from '@/lib/statusColors';
import { reportsApi, reportKeys } from '@/components/reports/api';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { CATEGORY_LABELS, DATE_PRESETS, EMPTY_SPEC, VALUELESS_OPERATORS, VISIBILITY_LABELS, aggregateAlias, AGGREGATE_LABELS, visibilityOf, type CatalogEntity, type CustomReport, type DefinitionInput, type PreviewResult, type ReportDefinition, type ReportSpec } from '@/components/reports/types';
import { Section } from '@/components/reports/builder/Section';
import { SavedReportsPanel } from '@/components/reports/builder/SavedReportsPanel';
import { DescribeBox } from '@/components/reports/builder/DescribeBox';
import { EntityPicker } from '@/components/reports/builder/EntityPicker';
import { ColumnPicker } from '@/components/reports/builder/ColumnPicker';
import { FilterEditor } from '@/components/reports/builder/FilterEditor';
import { GroupEditor } from '@/components/reports/builder/GroupEditor';
import { SortLimitEditor } from '@/components/reports/builder/SortLimitEditor';
import { ChartEditor } from '@/components/reports/builder/ChartEditor';
import { ScopeEditor } from '@/components/reports/builder/ScopeEditor';
import { SharingEditor } from '@/components/reports/builder/SharingEditor';
import { SpecSummary } from '@/components/reports/builder/SpecSummary';

const emptyDraft = (): DefinitionInput => ({ name: '', description: null, category: 'custom', entity: '', spec: { ...EMPTY_SPEC }, defaultDateRange: 'last_30_days', scopeCustomerId: null, visibility: 'private', sharedRoleKeys: [], sharedTeamIds: [], portalVisible: false, cover: false });
const toDraft = (r: CustomReport): DefinitionInput => ({ name: r.name, description: r.description, category: r.category, entity: r.entity, spec: { ...EMPTY_SPEC, ...r.spec }, defaultDateRange: r.defaultDateRange, scopeCustomerId: r.scopeCustomerId, visibility: r.visibility, sharedRoleKeys: r.sharedRoleKeys ?? [], sharedTeamIds: r.sharedTeamIds ?? [], portalVisible: r.portalVisible, cover: r.cover });
const CATEGORIES = ['custom', 'tickets', 'sla', 'customers', 'contracts', 'amc', 'assets', 'cmdb', 'field', 'pm', 'noc', 'soc', 'scope', 'audit'];

/** Keeps the sort, the aggregates and the chart consistent with the columns and the grouping after every edit. */
function normalise(spec: ReportSpec): ReportSpec {
  const grouped = spec.groupBy.length > 0;
  const aggregates = grouped ? spec.aggregates : [];
  const aliases = aggregates.map(aggregateAlias);
  const sortKeys = grouped ? [...spec.groupBy, ...aliases] : spec.columns;
  const sort = spec.sort && sortKeys.includes(spec.sort.key) ? spec.sort : null;
  let chart = spec.chart;
  if (!grouped) chart = null;
  else if (chart) {
    const y = chart.y.filter((k) => aliases.includes(k));
    chart = y.length ? { ...chart, y } : chart.y.length ? null : chart;
  }
  return { ...spec, aggregates, sort, chart };
}

const configured = (spec: ReportSpec) => spec.columns.length > 0 || spec.filters.length > 0 || spec.groupBy.length > 0;

/** The first thing the server would refuse, in the person's words, or null when the draft can be previewed (and, for a save, named). */
function problemOf(d: DefinitionInput, entity: CatalogEntity | null, forSave: boolean): string | null {
  if (!entity) return 'Pick an entity first';
  const label = (k: string) => entity.fields.find((f) => f.key === k)?.label ?? k;
  const grouped = d.spec.groupBy.length > 0;
  if (!grouped && d.spec.columns.length === 0) return 'Pick at least one column';
  if (grouped && d.spec.aggregates.length === 0) return 'Add at least one aggregate';
  const noField = d.spec.aggregates.find((a) => a.fn !== 'count' && !a.field);
  if (noField) return `Choose a field for the ${AGGREGATE_LABELS[noField.fn].toLowerCase()} aggregate`;
  const aliases = d.spec.aggregates.map(aggregateAlias);
  if (new Set(aliases).size !== aliases.length) return 'An aggregate is listed twice';
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const incomplete = d.spec.filters.find((f) => !VALUELESS_OPERATORS.includes(f.op) && (blank(f.value) || (Array.isArray(f.value) && (f.value.length === 0 || f.value.some(blank)))));
  if (incomplete) return `Give the "${label(incomplete.field)}" filter a value`;
  if (d.spec.chart && d.spec.chart.y.length === 0) return 'Pick at least one chart series';
  if (d.scopeCustomerId === '') return 'Choose the customer the report is fixed to';
  if (forSave && !d.name.trim()) return 'Give the report a name';
  return null;
}

type PreviewParams = { customerId: string; dateRange: string; from: string; to: string };

/**
 * The report builder: pick an entity, columns, filters, grouping, sort, period
 * and sharing on the left; preview live on the right; save into the catalogue.
 * Edits an existing custom report when the route carries its id.
 */
export default function ReportBuilderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search] = useSearchParams();
  const canBuild = useAuthStore((s) => s.can)('reports:build');
  const customers = useCustomersLookup();
  const catalog = useQuery({ queryKey: reportKeys.catalog, queryFn: reportsApi.catalog, staleTime: 5 * 60_000 });
  const one = useQuery({ queryKey: reportKeys.customOne(id ?? ''), queryFn: () => reportsApi.customOne(id!), enabled: !!id, retry: false });

  const [draft, setDraft] = useState<DefinitionInput>(emptyDraft);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyDraft()));
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [previewParams, setPreviewParams] = useState<PreviewParams>({ customerId: '', dateRange: '', from: '', to: '' });
  const [pendingEntity, setPendingEntity] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const loadedId = useRef<string | null>(null);

  // the stored definition arrives: load it once per id (a later refetch never overwrites edits)
  useEffect(() => {
    if (!id) {
      if (loadedId.current) {
        loadedId.current = null;
        setDraft(emptyDraft());
        setBaseline(JSON.stringify(emptyDraft()));
        setResult(null);
      }
      return;
    }
    if (one.data && loadedId.current !== one.data.id) {
      loadedId.current = one.data.id;
      const d = toDraft(one.data);
      setDraft(d);
      setBaseline(JSON.stringify(d));
      setResult(null);
    }
  }, [id, one.data]);

  const entities = catalog.data?.entities ?? [];
  const entity = useMemo(() => entities.find((e) => e.key === draft.entity) ?? null, [entities, draft.entity]);
  const dirty = JSON.stringify(draft) !== baseline;
  const grouped = draft.spec.groupBy.length > 0;

  const applyEntity = useCallback((key: string) => {
    const e = entities.find((x) => x.key === key);
    if (!e) return;
    setDraft((d) => ({ ...d, entity: key, spec: { ...EMPTY_SPEC, columns: [...e.defaultColumns], dateField: e.defaultDateField }, portalVisible: false }));
    setResult(null);
  }, [entities]);

  // ?entity= prefills a new report
  useEffect(() => {
    const e = search.get('entity');
    if (!id && e && entities.length && !draft.entity && entities.some((x) => x.key === e && x.permissionsOk)) applyEntity(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities.length, id]);

  // unsaved changes survive a closed tab only through this prompt
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const setSpec = (patch: Partial<ReportSpec>) => setDraft((d) => ({ ...d, spec: normalise({ ...d.spec, ...patch }) }));
  const patchDraft = (patch: Partial<DefinitionInput>) => setDraft((d) => ({ ...d, ...patch }));
  const pickEntity = (key: string) => {
    if (key === draft.entity) return;
    if (draft.entity && configured(draft.spec)) setPendingEntity(key);
    else applyEntity(key);
  };

  const fieldLabel = (k: string) => entity?.fields.find((f) => f.key === k)?.label ?? k;
  const blockingFields = useMemo(() => {
    if (!entity) return [];
    const used = new Set<string>([...draft.spec.columns, ...draft.spec.groupBy, ...draft.spec.filters.map((f) => f.field), ...draft.spec.aggregates.map((a) => a.field).filter((x): x is string => !!x), ...(draft.spec.dateField ? [draft.spec.dateField] : [])]);
    return [...used].filter((k) => entity.fields.find((f) => f.key === k)?.portal === false).map(fieldLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, draft.spec]);
  // a staff-only field slipped in after publication: the server refuses the save, so switch the flag off in the draft too
  useEffect(() => {
    if (draft.portalVisible && blockingFields.length) patchDraft({ portalVisible: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockingFields.length]);

  const sortKeys = useMemo(() => {
    if (!entity) return [];
    if (grouped) return [...draft.spec.groupBy.map((k) => ({ value: k, label: fieldLabel(k) })), ...draft.spec.aggregates.map((a) => ({ value: aggregateAlias(a), label: a.label?.trim() || (a.fn === 'count' ? 'Count' : `${AGGREGATE_LABELS[a.fn]} ${fieldLabel(a.field ?? '').toLowerCase()}`) }))];
    return draft.spec.columns.map((k) => ({ value: k, label: fieldLabel(k) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, grouped, draft.spec.groupBy, draft.spec.aggregates, draft.spec.columns]);

  const preview = useMutation({
    mutationFn: () => {
      const p: Record<string, unknown> = {};
      const customerId = draft.scopeCustomerId || previewParams.customerId;
      if (customerId) p.customerId = customerId;
      const range = previewParams.dateRange || draft.defaultDateRange;
      p.dateRange = range;
      if (range === 'custom') {
        p.from = previewParams.from || undefined;
        p.to = previewParams.to || undefined;
      }
      return reportsApi.preview({ entity: draft.entity, spec: draft.spec, parameters: p, portal: false });
    },
    onSuccess: (r) => setResult(r),
    onError: (e: ApiError) => toast.error(e.message),
  });
  const runPreview = () => {
    const problem = problemOf(draft, entity, false);
    if (problem) return toast.error(problem);
    preview.mutate();
  };

  const save = useMutation({
    mutationFn: async (run: boolean) => ({ saved: id ? await reportsApi.update(id, draft) : await reportsApi.create(draft), run }),
    onSuccess: ({ saved, run }) => {
      qc.invalidateQueries({ queryKey: ['reports'] });
      const d = toDraft(saved);
      loadedId.current = saved.id;
      setDraft(d);
      setBaseline(JSON.stringify(d));
      toast.success(`Saved "${saved.name}"`);
      if (run) navigate(`/reports?tab=run&report=${saved.key}`);
      else if (!id) navigate(`/reports/builder/${saved.id}`, { replace: true });
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const doSave = (run: boolean) => {
    const problem = problemOf(draft, entity, true);
    if (problem) return toast.error(problem);
    save.mutate(run);
  };
  const duplicate = useMutation({
    mutationFn: () => reportsApi.duplicate(id!),
    onSuccess: (copy) => {
      qc.invalidateQueries({ queryKey: ['reports'] });
      toast.success(`Copied as "${copy.name}"`);
      navigate(`/reports/builder/${copy.id}`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: () => reportsApi.update(id!, { isActive: true }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['reports'] });
      toast.success(`Restored "${saved.name}"`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => reportsApi.remove(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports'] });
      setDeleting(false);
      setBaseline(JSON.stringify(draft));
      toast.success('Report retired; its past runs stay in History');
      navigate('/reports/builder');
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  const title = id ? draft.name || 'Edit custom report' : draft.name || 'New custom report';
  const stored = one.data;
  const subtitle = (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{id ? 'Change the definition, preview, save' : 'Pick an entity, choose columns, add filters, preview, save'}</span>
      {stored && <Badge color={REPORT_VISIBILITY_COLORS[visibilityOf(stored)]}>{VISIBILITY_LABELS[visibilityOf(stored)]}</Badge>}
      {stored?.ownerName && <span className="text-subtle">Built by {stored.ownerName}</span>}
      {stored && !stored.isActive && <Badge color="amber">Retired</Badge>}
      {dirty && <Badge color="amber">Unsaved changes</Badge>}
    </span>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button icon={<Eye className="h-4 w-4" />} loading={preview.isPending} disabled={!entity} onClick={runPreview}>Preview</Button>
      <Button variant="outline" icon={<Save className="h-4 w-4" />} loading={save.isPending && save.variables === false} disabled={!entity || (!!stored && !stored.canEdit)} onClick={() => doSave(false)}>Save</Button>
      <Button variant="outline" icon={<Play className="h-4 w-4" />} loading={save.isPending && save.variables === true} disabled={!entity || (!!stored && !stored.canEdit)} onClick={() => doSave(true)}>Save and run</Button>
      {id && stored && (
        <Menu
          trigger={<Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>}
          items={[
            ...(canBuild ? [{ label: 'Duplicate', icon: <Copy className="h-3.5 w-3.5" />, onClick: () => duplicate.mutate() }] : []),
            ...(stored.isActive
              ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, disabled: !stored.canDelete, onClick: () => setDeleting(true) }]
              : [{ label: 'Restore', icon: <RotateCcw className="h-3.5 w-3.5" />, disabled: !stored.canDelete, onClick: () => restore.mutate() }]),
          ]}
        />
      )}
    </div>
  );

  const synthetic: ReportDefinition | null = result ? { key: id ? `custom:${id}` : 'custom:draft', name: draft.name || 'Untitled report', description: '', category: draft.category, permissions: [], portal: false, parameters: [], defaultDateRange: draft.defaultDateRange } : null;
  const previewCustomer = draft.scopeCustomerId || previewParams.customerId;
  const previewRange = previewParams.dateRange || draft.defaultDateRange;

  return (
    <div className="space-y-4">
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      <ModuleNav items={REPORT_MODULES} />
      {catalog.isPending && <LoadingBlock label="Loading the field catalogue…" />}
      {catalog.isError && <ErrorBlock error={catalog.error} retry={() => catalog.refetch()} />}
      {id && one.isError && ((one.error as ApiError)?.status === 404 ? <EmptyState title="This report is not available to you" description="It was retired, or it is private to somebody else." action={<Button variant="outline" onClick={() => navigate('/reports/builder')}>Back to the builder</Button>} /> : <ErrorBlock error={one.error} retry={() => one.refetch()} />)}
      {id && one.isPending && <LoadingBlock label="Loading the report…" />}
      {catalog.data && (!id || one.data) && (
        <>
          {!id && <SavedReportsPanel />}
          <DescribeBox entity={draft.entity || undefined} dirty={dirty && configured(draft.spec)} onFill={(def) => { setDraft((d) => ({ ...d, ...def, spec: normalise({ ...EMPTY_SPEC, ...(def.spec ?? {}) }), name: def.name ?? d.name })); setResult(null); }} />
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-start">
            <Card padded={false} className="min-w-0" data-config>
              <Section title="Report" summary={draft.name || 'Unnamed'}>
                <Field label="Name" required><Input value={draft.name} maxLength={160} onChange={(e) => patchDraft({ name: e.target.value })} placeholder="P1 and P2 incidents by customer" aria-label="Report name" /></Field>
                <Field label="Description"><Textarea value={draft.description ?? ''} maxLength={1000} onChange={(e) => patchDraft({ description: e.target.value || null })} placeholder="What the report answers and who it is for" className="min-h-[56px]" aria-label="Description" /></Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
                  <Field label="Category"><Select value={draft.category} onChange={(e) => patchDraft({ category: e.target.value })} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))} aria-label="Category" /></Field>
                  <div className="pb-2"><Toggle checked={draft.cover} onChange={(v) => patchDraft({ cover: v })} label="Cover page on PDF and HTML" /></div>
                </div>
              </Section>
              <Section title="Entity" summary={entity?.label ?? 'Not chosen'}>
                <EntityPicker entities={entities} value={draft.entity || null} onChange={pickEntity} />
              </Section>
              {entity && (
                <>
                  <Section title="Columns" summary={grouped ? 'Group fields and aggregates' : `${draft.spec.columns.length} chosen`}>
                    {grouped ? <div className="text-[12px] text-subtle">Grouped: the result shows the group fields, then one column per aggregate. Switch grouping off to pick columns.</div> : <ColumnPicker fields={entity.fields} value={draft.spec.columns} onChange={(columns) => setSpec({ columns })} />}
                  </Section>
                  <Section title="Filters" summary={draft.spec.filters.length ? `${draft.spec.filters.length} filter${draft.spec.filters.length === 1 ? '' : 's'}` : 'None'}>
                    <FilterEditor fields={entity.fields} filters={draft.spec.filters} match={draft.spec.match} operators={catalog.data.operators} operatorLabels={catalog.data.operatorLabels} scopeCustomerId={draft.scopeCustomerId} onChange={(filters) => setSpec({ filters })} onMatch={(match) => setSpec({ match })} />
                  </Section>
                  <Section title="Scope and period" summary={`${draft.scopeCustomerId ? customers.data?.items.find((c) => c.id === draft.scopeCustomerId)?.name ?? 'One customer' : 'Any customer'} · ${draft.spec.dateField ? fieldLabel(draft.spec.dateField) : 'No period'}`}>
                    <ScopeEditor scopeCustomerId={draft.scopeCustomerId} dateField={draft.spec.dateField} dateFields={entity.dateFields} fields={entity.fields} defaultDateRange={draft.defaultDateRange} presets={catalog.data.presets} onChange={(p) => { if ('scopeCustomerId' in p) patchDraft({ scopeCustomerId: p.scopeCustomerId ?? null }); if ('dateField' in p) setSpec({ dateField: p.dateField ?? null }); if (p.defaultDateRange) patchDraft({ defaultDateRange: p.defaultDateRange }); }} />
                  </Section>
                  <Section title="Group and aggregate" summary={grouped ? `By ${draft.spec.groupBy.map(fieldLabel).join(' and ')}` : 'Off'}>
                    <GroupEditor fields={entity.fields} groupBy={draft.spec.groupBy} aggregates={draft.spec.aggregates} onChange={(p) => setSpec(p)} />
                  </Section>
                  <Section title="Sort and limit" summary={draft.spec.sort ? `${sortKeys.find((k) => k.value === draft.spec.sort?.key)?.label ?? draft.spec.sort.key} ${draft.spec.sort.order === 'asc' ? '↑' : '↓'}` : 'Default'} open={false}>
                    <SortLimitEditor keys={sortKeys} sort={draft.spec.sort} rowLimit={draft.spec.rowLimit} maxRows={catalog.data.limits.maxRows} onSort={(sort) => setSpec({ sort })} onLimit={(rowLimit) => setSpec({ rowLimit })} />
                  </Section>
                  <Section title="Chart" summary={draft.spec.chart ? `${draft.spec.chart.type === 'bar' ? 'Bar' : 'Line'} · ${draft.spec.chart.y.length} series` : 'None'} open={grouped}>
                    <ChartEditor grouped={grouped} aggregates={draft.spec.aggregates} fields={entity.fields} chart={draft.spec.chart} onChange={(chart) => setSpec({ chart })} />
                  </Section>
                  <Section title="Sharing" summary={draft.portalVisible ? 'Portal' : draft.visibility === 'shared' ? `Shared · ${draft.sharedRoleKeys.length + draft.sharedTeamIds.length}` : 'Only me'}>
                    <SharingEditor visibility={draft.visibility} sharedRoleKeys={draft.sharedRoleKeys} sharedTeamIds={draft.sharedTeamIds} portalVisible={draft.portalVisible} shareTargets={catalog.data.shareTargets} entity={entity} blockingFields={blockingFields} onChange={(p) => patchDraft(p)} />
                  </Section>
                </>
              )}
            </Card>
            <div className="flex flex-col gap-4 min-w-0" data-preview-pane>
              {entity && (
                <Card title="Preview" actions={result ? <span className="text-[12px] text-subtle">{result.period.label}</span> : null}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    <Field label="Customer" hint={draft.scopeCustomerId ? 'Fixed by the report' : undefined}>
                      <Select value={previewCustomer} disabled={!!draft.scopeCustomerId} onChange={(e) => setPreviewParams((p) => ({ ...p, customerId: e.target.value }))} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} aria-label="Preview customer" />
                    </Field>
                    <Field label="Period" hint={draft.spec.dateField ? undefined : 'Not applied: the report has no period field'}>
                      <Select value={previewRange} disabled={!draft.spec.dateField} onChange={(e) => setPreviewParams((p) => ({ ...p, dateRange: e.target.value }))} options={DATE_PRESETS} aria-label="Preview period" />
                    </Field>
                    {previewRange === 'custom' && draft.spec.dateField && (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="From"><Input type="date" value={previewParams.from} onChange={(e) => setPreviewParams((p) => ({ ...p, from: e.target.value }))} /></Field>
                        <Field label="To"><Input type="date" value={previewParams.to} onChange={(e) => setPreviewParams((p) => ({ ...p, to: e.target.value }))} /></Field>
                      </div>
                    )}
                  </div>
                  {result && <SpecSummary lines={result.summaryLines} className="mt-3 pt-3 border-t border-default" />}
                </Card>
              )}
              {preview.isPending && <LoadingBlock label="Running the preview…" />}
              {result && synthetic && !preview.isPending && <ReportPreview preview={{ report: synthetic, parameters: { customerId: previewCustomer || undefined, dateRange: previewRange }, period: result.period, result: { ...result, charts: result.charts?.map((c) => ({ ...c, title: synthetic.name })) } }} />}
              {!result && !preview.isPending && (
                <Card>
                  <EmptyState icon={<BarChart3 className="h-6 w-6" />} title="Preview your report" description={entity ? `Up to ${catalog.data.limits.previewRows.toLocaleString('en-GB')} rows with the summary tiles and the chart, exactly as the saved report will run.` : 'Pick an entity in the configuration card to begin.'} action={<Button icon={<Eye className="h-4 w-4" />} disabled={!entity} loading={preview.isPending} onClick={runPreview}>Preview</Button>} />
                </Card>
              )}
            </div>
          </div>
        </>
      )}
      <ConfirmDialog open={!!pendingEntity} onClose={() => setPendingEntity(null)} onConfirm={() => { if (pendingEntity) applyEntity(pendingEntity); setPendingEntity(null); }} title="Change the entity?" description="The columns, filters, grouping and sort you configured belong to the current entity and will be cleared." confirmLabel="Change entity" />
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} title="Retire this report?" description={`"${draft.name}" leaves the catalogue and the picker. Its past runs stay in History; a report manager can restore it from "Your custom reports" with "Include retired" ticked. A report with schedules cannot be retired until they are removed.`} confirmLabel="Delete" danger loading={remove.isPending} />
    </div>
  );
}
