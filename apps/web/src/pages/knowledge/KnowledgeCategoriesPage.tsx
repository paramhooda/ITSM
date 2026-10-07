import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Folder, CornerDownRight } from 'lucide-react';
import { get, post, patch, del } from '@/api/client';
import { PageHeader, ModuleNav, Button, Badge, type Column } from '@/components/ui';
import { KNOWLEDGE_MODULES } from '@/layouts/modules';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { ConfigTable, MonoCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { errorMessage } from '@/components/admin/api';
import { fmtNumber } from '@/lib/format';
import { DOMAIN_OPTIONS, type KbCategory } from '@/components/knowledge/ArticleEditor';

interface CategoryValues extends Record<string, unknown> {
  name: string;
  key: string;
  description: string;
  parentId: string | null;
  domain: string;
  sortOrder: number | null;
}

interface TreeRow extends KbCategory {
  depth: number;
  /** Own articles plus those of every descendant. */
  totalCount: number;
}

const KEY = ['knowledge', 'categories'] as const;
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);

/** Categories module: the folder tree articles are filed under, with per-category article counts. */
export default function KnowledgeCategoriesPage() {
  const qc = useQueryClient();
  const editor = useEditor<TreeRow>();
  const list = useQuery({ queryKey: KEY, queryFn: () => get<{ items: KbCategory[]; uncategorized: number }>('/knowledge/categories'), staleTime: 60_000 });

  const rows = useMemo<TreeRow[]>(() => {
    const cats = list.data?.items ?? [];
    const byParent = new Map<string | null, KbCategory[]>();
    cats.forEach((c) => byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]));
    const total = (c: KbCategory): number => (c.articleCount ?? 0) + (byParent.get(c.id) ?? []).reduce((n, ch) => n + total(ch), 0);
    const out: TreeRow[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        out.push({ ...c, depth, totalCount: total(c) });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    // Orphans (parent deleted elsewhere) still show, at the root.
    const seen = new Set(out.map((r) => r.id));
    cats.filter((c) => !seen.has(c.id)).forEach((c) => out.push({ ...c, depth: 0, totalCount: total(c) }));
    return out;
  }, [list.data]);

  const f = useConfigFilter(rows, {
    search: [(r) => r.name, (r) => r.key, (r) => r.description],
    selects: [{ key: 'domain', label: 'Domain', options: DOMAIN_OPTIONS, predicate: (r, v) => r.domain === v }],
    noun: ['category', 'categories'],
    searchPlaceholder: 'Search categories',
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  const save = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Record<string, unknown> }) => (id ? patch<KbCategory>(`/knowledge/categories/${id}`, body) : post<KbCategory>('/knowledge/categories', body)),
    onSuccess: (c, v) => {
      invalidate();
      toast.success(v.id ? `Category “${c.name}” updated` : `Category “${c.name}” created`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/knowledge/categories/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Category deleted');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /** A category cannot be its own parent, nor sit under one of its descendants. */
  const descendants = (id: string) => {
    const ids = new Set<string>();
    const walk = (p: string) => rows.filter((r) => r.parentId === p).forEach((r) => { ids.add(r.id); walk(r.id); });
    walk(id);
    return ids;
  };
  const editing = editor.row;
  const blocked = editing ? descendants(editing.id) : new Set<string>();
  const parentOptions = rows.filter((r) => r.id !== editing?.id && !blocked.has(r.id)).map((r) => ({ value: r.id, label: `${'— '.repeat(r.depth)}${r.name}` }));
  const fields: FieldSpec<CategoryValues>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Network runbooks' },
    { key: 'key', label: 'Key', type: 'key', required: true, placeholder: 'network_runbooks', hint: 'Stable identifier used in links and imports' },
    { key: 'parentId', label: 'Parent', type: 'select', options: parentOptions, placeholder: '— top level —' },
    { key: 'domain', label: 'Domain', type: 'select', options: DOMAIN_OPTIONS, required: true },
    { key: 'sortOrder', label: 'Order', type: 'number', min: 0, step: 1, hint: 'Lower sorts first among siblings' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2, placeholder: 'What belongs here' },
  ];
  const initial: CategoryValues = editing
    ? { name: editing.name, key: editing.key, description: editing.description ?? '', parentId: editing.parentId, domain: editing.domain, sortOrder: editing.sortOrder }
    : { name: '', key: '', description: '', parentId: null, domain: 'general', sortOrder: null };

  const columns: Column<TreeRow>[] = [
    {
      key: 'name',
      header: 'Category',
      // A filtered view is a flat list of matches (their parents may not match), so the tree indent only draws on the full tree.
      render: (r) => (
        <div className="flex items-center gap-2 min-w-0" style={{ paddingLeft: f.filtered ? 0 : r.depth * 18 }}>
          {r.depth > 0 && !f.filtered ? <CornerDownRight className="h-3.5 w-3.5 text-subtle shrink-0" /> : <Folder className="h-3.5 w-3.5 text-subtle shrink-0" />}
          <div className="min-w-0">
            <div className="font-medium truncate">{r.name}</div>
            {r.description && <div className="text-[11.5px] text-subtle truncate max-w-[48ch]">{r.description}</div>}
          </div>
        </div>
      ),
    },
    { key: 'key', header: 'Key', width: '180px', render: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: 'domain', header: 'Domain', width: '130px', render: (r) => <Badge color="slate">{DOMAIN_OPTIONS.find((o) => o.value === r.domain)?.label ?? r.domain}</Badge> },
    {
      key: 'articles',
      header: 'Articles',
      width: '140px',
      className: 'text-right tabular-nums',
      render: (r) => (
        <Link to={`/knowledge/articles?categoryId=${r.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
          {fmtNumber(r.articleCount ?? 0)}
          {r.totalCount !== (r.articleCount ?? 0) && <span className="text-subtle"> · {fmtNumber(r.totalCount)} incl. children</span>}
        </Link>
      ),
    },
    { key: 'sortOrder', header: 'Order', width: '80px', className: 'text-right tabular-nums text-muted' },
  ];
  const uncategorized = list.data?.uncategorized ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Categories" subtitle="How articles are organised" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New category</Button>} />
      <ModuleNav items={KNOWLEDGE_MODULES} />
      <div>
        <ConfigToolbar {...f.toolbar}>
          {uncategorized > 0 && (
            <Link to="/knowledge/articles" className="text-[12.5px] text-amber-700 hover:underline whitespace-nowrap">{fmtNumber(uncategorized)} uncategorised {uncategorized === 1 ? 'article' : 'articles'}</Link>
          )}
        </ConfigToolbar>
      <ConfigTable<TreeRow>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        retry={() => list.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No categories match' : 'No categories yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Create the first category to start filing articles.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, inline: true, onClick: editor.edit },
          {
            label: 'Delete',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            onClick: (r) => remove.mutate(r.id),
            confirm: (r) => ({ title: `Delete “${r.name}”?`, description: r.totalCount > 0 ? `${fmtNumber(r.totalCount)} ${r.totalCount === 1 ? 'article is' : 'articles are'} filed here or in its sub-categories; they become uncategorised.` : 'This cannot be undone.', confirmLabel: 'Delete', danger: true }),
          },
        ]}
      />
      </div>
      <FormDialog<CategoryValues>
        open={editor.open}
        onClose={editor.close}
        title={editing ? 'Edit category' : 'New category'}
        fields={fields}
        initial={initial}
        submitLabel={editing ? 'Save' : 'Create'}
        onSubmit={async (v) => {
          const body = { name: v.name.trim(), key: (v.key || slug(v.name)).trim(), description: v.description?.trim() ? v.description.trim() : null, parentId: v.parentId || null, domain: v.domain, sortOrder: v.sortOrder === null || v.sortOrder === undefined ? 0 : Number(v.sortOrder) };
          await save.mutateAsync({ id: editing?.id ?? null, body });
        }}
      >
        {(v, setValues) => (!editing && v.name && !v.key ? <button type="button" className="text-[12px] text-brand-700 hover:underline self-start -mt-2" onClick={() => setValues({ key: slug(v.name) })}>Use “{slug(v.name)}” as the key</button> : null)}
      </FormDialog>
    </div>
  );
}
