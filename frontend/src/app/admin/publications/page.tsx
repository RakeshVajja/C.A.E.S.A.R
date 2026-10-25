"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { CuratedChip, SourceChips, StatusChip } from "@/components/chips";
import { Button, EmptyState, LoadError, PageHeader, Pagination, Panel, SkeletonRows } from "@/components/ui";
import { api, query } from "@/lib/api";
import { formatNumber, TYPE_LABEL, TYPE_OPTIONS } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Paged, PublicationSummary } from "@/lib/types";

/** All publications, suppressed included (Phase 13B). Filters and paging live in the URL. */

const PAGE_SIZE = 50;

function PublicationSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const typeFamily = params.get("type") ?? "";
  const curated = params.get("curated") ?? "";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const [text, setText] = useState(q);

  useEffect(() => {
    // Back/forward navigation updates the search box.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(q);
  }, [q]);

  const key = `/admin/publications${query({ q, status, typeFamily, curated, limit: PAGE_SIZE, offset })}`;
  const { data, error, reload } = useResource(key, (signal) => api<Paged & { publications: PublicationSummary[] }>(key, { signal }));

  const go = (next: Record<string, string | number | undefined>) => {
    const merged = { q, status, type: typeFamily, curated, offset: 0, ...next };
    router.replace(`${pathname}${query({ ...merged, offset: merged.offset || undefined })}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: text.trim() });
        }}
        className="flex flex-col gap-3 lg:flex-row lg:items-end"
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="pub-q" className="text-[13px] font-medium">
            Title or DOI
          </label>
          <div className="flex gap-2">
            <input
              id="pub-q"
              className="input"
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. model checking, or 10.1145/…"
            />
            <Button type="submit" variant="primary" icon={<Search aria-hidden size={18} />}>
              Search
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:w-[34rem]">
          <Filter
            id="f-status"
            label="Status"
            value={status}
            onChange={(v) => go({ status: v })}
            options={[
              ["", "All"],
              ["ACTIVE", "Active"],
              ["SUPPRESSED", "Suppressed"],
            ]}
          />
          <Filter
            id="f-type"
            label="Type"
            value={typeFamily}
            onChange={(v) => go({ type: v })}
            options={[["", "All types"], ...TYPE_OPTIONS.map((t) => [t, TYPE_LABEL[t]] as [string, string])]}
          />
          <Filter
            id="f-curated"
            label="Curation"
            value={curated}
            onChange={(v) => go({ curated: v })}
            options={[
              ["", "All"],
              ["true", "Curated"],
              ["false", "Not curated"],
            ]}
          />
        </div>
      </form>

      <Panel>
        {error && !data ? (
          <div className="p-4">
            <LoadError error={error} onRetry={() => void reload()} />
          </div>
        ) : !data ? (
          <SkeletonRows rows={8} label="Loading publications" />
        ) : data.publications.length === 0 ? (
          <EmptyState>
            {q || status || typeFamily || curated
              ? "No publications match these filters."
              : "No publications yet. They appear after the first synchronization."}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">Publications, {data.total} matching</caption>
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col" className="max-lg:hidden">
                      Type
                    </th>
                    <th scope="col">Sources</th>
                    <th scope="col" className="num">
                      Professors
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.publications.map((p) => (
                    <tr key={p.id}>
                      <td className="no-label min-w-[16rem]">
                        <Link
                          href={`/admin/publications/${p.id}`}
                          className="font-serif text-base leading-6 font-medium text-ink hover:underline underline-offset-4"
                        >
                          {p.title}
                        </Link>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-text-muted">
                          <span className="lg:hidden">{TYPE_LABEL[p.typeFamily]} · </span>
                          {[p.venue, p.year ?? "Year unknown", p.doi].filter(Boolean).join(" · ")}
                        </p>
                      </td>
                      <td data-label="Type" className="text-[13px] whitespace-nowrap max-lg:hidden">
                        {TYPE_LABEL[p.typeFamily]}
                      </td>
                      <td data-label="Sources">
                        <SourceChips sources={p.sources} />
                        {p.sourceRecordCount > p.sources.length && (
                          <p className="mt-1 text-[13px] text-text-muted">{formatNumber(p.sourceRecordCount)} records</p>
                        )}
                      </td>
                      <td data-label="Professors" className="num text-[13px]">
                        <span title="Approved / pending / rejected">
                          {formatNumber(p.relationshipCounts.approved)} approved
                          {p.relationshipCounts.pending > 0 && (
                            <span className="block text-text-muted">{formatNumber(p.relationshipCounts.pending)} pending</span>
                          )}
                          {p.relationshipCounts.rejected > 0 && (
                            <span className="block text-text-muted">{formatNumber(p.relationshipCounts.rejected)} rejected</span>
                          )}
                        </span>
                      </td>
                      <td data-label="Status">
                        <div className="flex flex-wrap gap-1">
                          {p.status === "SUPPRESSED" ? <StatusChip status="SUPPRESSED" /> : <span className="text-[13px] text-text-muted">Active</span>}
                          {p.isCurated && <CuratedChip />}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={data.offset} limit={data.limit} count={data.publications.length} total={data.total} onPage={(o) => go({ offset: o })} />
          </>
        )}
      </Panel>
    </div>
  );
}

function Filter({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function AdminPublicationsPage() {
  return (
    <>
      <PageHeader
        title="Publications"
        description="Every canonical publication, including suppressed ones. Open one to correct its metadata, suppress or restore it, or detach a wrongly attached source record."
      />
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <PublicationSearch />
      </Suspense>
    </>
  );
}
