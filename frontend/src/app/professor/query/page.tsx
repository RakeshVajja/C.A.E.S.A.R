"use client";

import { Suspense } from "react";
import { Eraser, Play } from "lucide-react";
import { QueryBuilder } from "@/components/query-builder";
import { PresetPicker, QueryResults, UnsavedChanges, useQueryWorkspace, WorkspaceNotice } from "@/components/query-workspace";
import { Button, LoadError, PageHeader, Panel, SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import type { PresetMeta, QueryFieldsResponse } from "@/lib/query-builder";
import { useResource } from "@/lib/use-resource";

/**
 * Query publications (Project_plan.md §24.7–§24.8; decisions #154–#159, stage Q2): the professor
 * builds conditions over their own verified publications. The server applies the professor scope
 * (own APPROVED links, ACTIVE publications) and validates every request; nothing here can widen it.
 * The applied query lives in the URL (D11); the shared workspace (components/query-workspace.tsx)
 * keeps builder, URL and rows consistent.
 */

const BASE = "/me/publication-queries";

export default function QueryPublicationsPage() {
  return (
    <>
      <PageHeader
        title="Query publications"
        description="Find publications among your approved publications by combining conditions. Select Apply to run the query; the address of this page then keeps it, so you can reload or bookmark it."
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <QueryScreen />
      </Suspense>
    </>
  );
}

function QueryScreen() {
  const meta = useResource<QueryFieldsResponse>(`${BASE}/fields`, (signal) => api<QueryFieldsResponse>(`${BASE}/fields`, { signal }));
  const presets = useResource<{ presets: PresetMeta[] }>(`${BASE}/presets`, (signal) => api<{ presets: PresetMeta[] }>(`${BASE}/presets`, { signal }));

  if (meta.error && !meta.data) return <LoadError error={meta.error} onRetry={() => void meta.reload()} />;
  if (!meta.data) return <SkeletonRows rows={6} label="Loading the query builder" />;
  return <ProfessorWorkspace meta={meta.data} presets={presets.data?.presets ?? null} presetsError={presets.error} reloadMeta={() => void meta.reload()} />;
}

function ProfessorWorkspace({
  meta,
  presets,
  presetsError,
  reloadMeta,
}: {
  meta: QueryFieldsResponse;
  presets: PresetMeta[] | null;
  presetsError: unknown;
  reloadMeta: () => void;
}) {
  const workspace = useQueryWorkspace({ base: BASE, meta, reloadMeta, admin: false });

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceNotice notice={workspace.notice} />

      <Panel className="flex flex-col gap-4 p-4">
        <PresetPicker base={BASE} presets={presets} error={presetsError} onLoad={workspace.loadPreset} />
        <hr className="border-border" />
        <QueryBuilder
          root={workspace.root}
          onChange={workspace.setRoot}
          meta={meta}
          issues={workspace.issues}
          emptyText="No conditions: all your approved publications are shown."
        />
        {!meta.scopus.available && (
          <p className="text-[13px] text-text-muted">Scopus citation data is not available yet, so citation conditions and sorting cannot be used.</p>
        )}
        <UnsavedChanges workspace={workspace} />
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button variant="primary" icon={<Play aria-hidden size={16} />} onClick={() => void workspace.apply()} loading={workspace.running} loadingLabel="Running…">
            Apply
          </Button>
          <Button variant="quiet" icon={<Eraser aria-hidden size={16} />} onClick={workspace.clear}>
            Clear
          </Button>
        </div>
      </Panel>

      <QueryResults
        workspace={workspace}
        sorts={meta.sorts}
        admin={false}
        emptyText="No publications match this query. Change or remove conditions and select Apply."
      />
    </div>
  );
}
