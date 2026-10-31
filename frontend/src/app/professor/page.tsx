"use client";

import Link from "next/link";
import { FilePlus2, ListChecks } from "lucide-react";
import { SourceChips } from "@/components/chips";
import { ButtonLink, EmptyState, Figures, LoadError, PageHeader, Panel, SectionTitle, SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, TYPE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { OwnList } from "@/lib/types";

/** Professor dashboard: decision counts and the next pending publications. */
export default function ProfessorDashboard() {
  const { user } = useAuth();
  const key = "/me/publications?status=PENDING&limit=5";
  const { data, error, reload } = useResource<OwnList>(key, (signal) => api<OwnList>(key, { signal }));

  return (
    <>
      <PageHeader
        title={user?.professor ? `Welcome, ${user.professor.name}` : "Dashboard"}
        description="Your publications collected from OpenAlex, DBLP, ORCID, Scopus and Web of Science, and the ones you added yourself."
        actions={
          <>
            <ButtonLink href="/professor/add" icon={<FilePlus2 aria-hidden size={18} />}>
              Add publication
            </ButtonLink>
            <ButtonLink href="/professor/pending" variant="primary" icon={<ListChecks aria-hidden size={18} />}>
              Review pending
            </ButtonLink>
          </>
        }
      />
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="flex flex-col gap-8">
          <Figures
            items={[
              { label: "Pending verification", value: data ? formatNumber(data.counts.PENDING) : "…", note: "Waiting for your decision" },
              { label: "Approved", value: data ? formatNumber(data.counts.APPROVED) : "…", note: "Your verified publications" },
              { label: "Rejected", value: data ? formatNumber(data.counts.REJECTED) : "…", note: "Not yours; kept rejected across syncs" },
            ]}
          />
          <section aria-labelledby="next-pending">
            <SectionTitle
              id="next-pending"
              actions={
                data && data.total > 0 ? (
                  <Link href="/professor/pending" className="text-[15px] text-ink hover:underline underline-offset-4">
                    View all {formatNumber(data.total)}
                  </Link>
                ) : undefined
              }
            >
              Next to review
            </SectionTitle>
            <Panel>
              {!data ? (
                <SkeletonRows rows={3} />
              ) : data.items.length === 0 ? (
                <EmptyState>You’re up to date. New publications appear here after the monthly synchronization.</EmptyState>
              ) : (
                <ul className="divide-y divide-border">
                  {data.items.map((item) => (
                    <li key={item.id} className="flex flex-col gap-1 px-4 py-3">
                      <p className="font-serif text-base leading-6 font-medium">{item.publication.title}</p>
                      <p className="text-[13px] leading-5 text-text-muted">
                        {[TYPE_LABEL[item.publication.typeFamily], item.publication.venue, item.publication.year ?? "Year unknown"].filter(Boolean).join(" · ")}
                      </p>
                      <SourceChips sources={item.publication.sources} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </section>
        </div>
      )}
    </>
  );
}
