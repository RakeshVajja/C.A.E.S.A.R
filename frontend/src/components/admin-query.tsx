"use client";

import { useSearchParams } from "next/navigation";
import { Eraser, Play } from "lucide-react";
import { LinkScopeEditor } from "./link-scope";
import { QueryBuilder } from "./query-builder";
import { PresetPicker, QueryResults, UnsavedChanges, useQueryWorkspace, WorkspaceNotice } from "./query-workspace";
import { Button, LoadError, Panel, SectionTitle, SkeletonRows } from "./ui";
import { api } from "@/lib/api";
import type { AppliedQuery, PresetMeta, QueryFieldsResponse, SearchResponse } from "@/lib/query-builder";

/** The table's state that the conditional analytics are checked against (matching-set fingerprint). */
export interface TableState {
  result: SearchResponse | null;
  failed: boolean;
  /** A table request is in flight (its fingerprint may be about to change). */
  running: boolean;
  /** Runs the table's query again (manual refresh after the matching set changed). */
  refresh: () => void;
}
import { useResource } from "@/lib/use-resource";
import type { ProfessorRow } from "@/lib/types";

/**
 * The administrator's conditional publication query on the Analytics page (Project_plan.md
 * §24.1, §24.4–§24.8; decisions #154–#159, stage Q3). Without an applied query nothing but the
 * builder is shown and the page's department-wide analytics are the default view. A new query
 * starts from the department population (D2, D3): link scope *Any professor, APPROVED* and the
 * visible, removable conditions *publication status is Active* and *type is none of Preprint*.
 *
 * With an applied query its matching publications are listed, followed by the conditional
 * analytics of exactly those publications (§24.6, stage Q4) in place of the department-wide view.
 * Clear removes the query from the URL and shows the department-wide view again, loaded from the
 * unchanged §16 endpoints exactly as without a query.
 */

const BASE = "/admin/publication-queries";

export function AdminQuerySection({
  department,
  conditional,
}: {
  /** The department-wide analytics: the view without an applied query. */
  department: React.ReactNode;
  /** The analytics of an applied query (rendered below its matching publications). */
  conditional: (query: AppliedQuery, table: TableState) => React.ReactNode;
}) {
  // Before the builder has loaded, the URL tells whether a query is applied (an administrator's query always has a link scope).
  const queryInUrl = useSearchParams().has("link");
  const meta = useResource<QueryFieldsResponse>(`${BASE}/fields`, (signal) => api<QueryFieldsResponse>(`${BASE}/fields`, { signal }));
  const presets = useResource<{ presets: PresetMeta[] }>(`${BASE}/presets`, (signal) => api<{ presets: PresetMeta[] }>(`${BASE}/presets`, { signal }));
  const professors = useResource<ProfessorRow[]>("/admin/professors", (signal) =>
    api<{ professors: ProfessorRow[] }>("/admin/professors", { signal }).then((r) => r.professors),
  );

  if (!meta.data) {
    return (
      <>
        <section aria-labelledby="query-heading" className="mb-10">
          <SectionTitle id="query-heading">Query publications</SectionTitle>
          {meta.error ? (
            <LoadError error={meta.error} onRetry={() => void meta.reload()} />
          ) : (
            <Panel>
              <SkeletonRows rows={3} label="Loading the query builder" />
            </Panel>
          )}
        </section>
        {!queryInUrl && department}
      </>
    );
  }
  return (
    <AdminWorkspace
      meta={meta.data}
      presets={presets.data?.presets ?? null}
      presetsError={presets.error}
      professors={professors.data}
      professorsError={professors.error}
      reloadMeta={() => void meta.reload()}
      department={department}
      conditional={conditional}
      queryInUrl={queryInUrl}
    />
  );
}

function AdminWorkspace({
  meta,
  presets,
  presetsError,
  professors,
  professorsError,
  reloadMeta,
  department,
  conditional,
  queryInUrl,
}: {
  department: React.ReactNode;
  conditional: (query: AppliedQuery, table: TableState) => React.ReactNode;
  queryInUrl: boolean;
  meta: QueryFieldsResponse;
  presets: PresetMeta[] | null;
  presetsError: unknown;
  professors: ProfessorRow[] | null;
  professorsError: unknown;
  reloadMeta: () => void;
}) {
  const workspace = useQueryWorkspace({ base: BASE, meta, reloadMeta, admin: true });
  const active = workspace.applied !== null;

  return (
    <>
    <section aria-labelledby="query-heading" className="mb-10">
    <SectionTitle id="query-heading">Query publications</SectionTitle>
    <div className="flex flex-col gap-4">
      <WorkspaceNotice notice={workspace.notice} />

      <Panel className="flex flex-col gap-4 p-4">
        <p className="text-[13px] leading-5 text-text-muted">
          List the publications that match conditions you choose. A new query starts from the department population — approved by any professor, active
          and not a preprint — and every part of it can be changed or removed.
        </p>
        <PresetPicker
          base={BASE}
          presets={presets}
          error={presetsError}
          onLoad={workspace.loadPreset}
          selectedProfessors={workspace.link?.mode === "SELECTED" ? workspace.link.professors : []}
        />
        <hr className="border-border" />
        {workspace.link && meta.link && (
          <LinkScopeEditor
            draft={workspace.link}
            onChange={workspace.setLink}
            options={meta.link}
            professors={professors}
            professorsError={professorsError}
            issue={workspace.linkIssue}
          />
        )}
        <hr className="border-border" />
        <QueryBuilder
          root={workspace.root}
          onChange={workspace.setRoot}
          meta={meta}
          issues={workspace.issues}
          emptyText="No conditions: every publication within the professor links above is listed."
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
            {active ? "Clear query" : "Reset"}
          </Button>
        </div>
      </Panel>

      {active && (
        <QueryResults
          workspace={workspace}
          sorts={meta.sorts}
          admin
          emptyText="No publications match these conditions."
          exportPath={`${BASE}/export`}
        />
      )}
    </div>
    </section>
    {/* §24.6: an applied query replaces the department-wide view with the analytics of its matching publications. */}
    {workspace.applied
      ? conditional(workspace.applied, { result: workspace.result, failed: workspace.loadError !== null, running: workspace.running, refresh: workspace.refresh })
      : !queryInUrl && department}
    </>
  );
}
