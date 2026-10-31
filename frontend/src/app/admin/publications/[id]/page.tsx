"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff, Pencil, Unlink } from "lucide-react";
import { CuratedChip, SourceChip, SourceChips, StatusChip } from "@/components/chips";
import { ScopusCitationNote } from "@/components/citations";
import { ConfirmDialog } from "@/components/dialog";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { useToast } from "@/components/toast";
import { Alert, Button, Doi, EmptyState, LoadError, Missing, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { BASIS_LABEL, DECLARED_BASES, formatDate, formatDateTime, SOURCE_LABEL, TYPE_LABEL, TYPE_OPTIONS } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { CuratedField, DeclaredBasis, PublicationDetail, SourceRecordSummary, TypeFamily } from "@/lib/types";

/** Publication detail: metadata curation, suppression, provenance and detachment (Phase 13B). */
export default function PublicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const path = `/admin/publications/${id}`;
  const { data, error, reload, setData } = useResource<PublicationDetail>(path, (signal) =>
    api<{ publication: PublicationDetail }>(path, { signal }).then((r) => r.publication),
  );

  if (error && !data) {
    return (
      <>
        <PageHeader title="Publication" breadcrumbs={[{ href: "/admin/publications", label: "Publications" }]} />
        <LoadError error={error} onRetry={error instanceof ApiError && error.status === 404 ? undefined : () => void reload()} />
      </>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-label="Loading publication" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title={data.title}
        breadcrumbs={[{ href: "/admin/publications", label: "Publications" }]}
        actions={
          <div className="flex flex-wrap gap-1">
            <StatusChip status={data.status} />
            {data.isCurated && <CuratedChip />}
          </div>
        }
      />
      <div className="flex flex-col gap-10">
        {data.status === "SUPPRESSED" && (
          <Alert tone="warning" title="Suppressed">
            Hidden from professors and analytics, and never linked again automatically. Its source records and relationships are kept.
          </Alert>
        )}
        <MetadataSection publication={data} onSaved={setData} />
        <SourceRecordsSection publication={data} onChanged={() => void reload()} />
        <RelationshipsSection publication={data} />
        <CandidatesSection publication={data} />
        <SuppressionSection publication={data} onSaved={setData} />
      </div>
    </>
  );
}

function MetadataSection({ publication, onSaved }: { publication: PublicationDetail; onSaved: (p: PublicationDetail) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const toForm = (p: PublicationDetail) => ({
    title: p.title,
    year: p.year?.toString() ?? "",
    venue: p.venue ?? "",
    typeFamily: p.typeFamily,
    authorNames: p.authorNamesDisplay ?? "",
    doi: p.doi ?? "",
  });
  const [form, setForm] = useState(toForm(publication));
  const [basis, setBasis] = useState<DeclaredBasis | "">("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFormErrors();
  const set = (k: keyof ReturnType<typeof toForm>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.title.trim()) local.title = "Enter the title";
    if (form.year && !/^\d{4}$/.test(form.year.trim())) local.year = "Enter a four-digit year";
    if (Object.keys(local).length) return errors.setLocal(local);
    const original = toForm(publication);
    const body: Record<string, unknown> = {};
    if (form.title !== original.title) body.title = form.title;
    if (form.year !== original.year) body.year = form.year.trim() ? Number(form.year) : null;
    if (form.venue !== original.venue) body.venue = form.venue.trim() || null;
    if (form.typeFamily !== original.typeFamily) body.typeFamily = form.typeFamily;
    if (form.authorNames !== original.authorNames) body.authorNames = form.authorNames.trim() || null;
    if (form.doi !== original.doi) body.doi = form.doi.trim() || null;
    if (Object.keys(body).length === 0) return setEditing(false);
    if (!basis) return errors.setLocal({ basis: "Choose where the new values come from" });
    if (basis === "INDEPENDENT" && !evidence.trim()) return errors.setLocal({ evidence: "Give the evidence for an independent value (DOI, publisher or repository link)" });
    body.basis = basis;
    body.evidence = evidence.trim() || null;
    errors.clear();
    setBusy(true);
    try {
      const { publication: saved } = await api<{ publication: PublicationDetail }>(`/admin/publications/${publication.id}`, { method: "PATCH", body });
      onSaved(saved);
      setEditing(false);
      toast("Metadata saved. The changed fields are now curated, so synchronization keeps them.");
    } catch (error) {
      errors.fromError(error, { INVALID_DOI: "doi", INVALID_TITLE: "title", DOI_IN_USE: "doi", EVIDENCE_REQUIRED: "evidence" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="meta-heading">
      <SectionTitle
        id="meta-heading"
        actions={
          !editing && (
            <Button
              compact
              icon={<Pencil aria-hidden size={16} />}
              onClick={() => {
                setForm(toForm(publication));
                setBasis("");
                setEvidence("");
                errors.clear();
                setEditing(true);
              }}
            >
              Edit metadata
            </Button>
          )
        }
      >
        Canonical metadata
      </SectionTitle>
      {editing ? (
        <form noValidate onSubmit={save} className="max-w-3xl">
          <Panel className="flex flex-col gap-4 px-5 py-5">
            <Alert tone="info">
              Each field you change becomes curated with the source you declare: synchronization no longer recomputes it. A value derived from a
              provider stays that provider&apos;s data and is removed with it.
            </Alert>
            <ErrorSummary
              errors={errors.fields}
              formError={errors.form}
              labels={{ title: "Title", year: "Year", venue: "Venue", typeFamily: "Type", authorNames: "Authors", doi: "DOI", basis: "Source of the new values", evidence: "Evidence" }}
              fieldIds={{ title: "m-title", year: "m-year", venue: "m-venue", typeFamily: "m-type", authorNames: "m-authors", doi: "m-doi", basis: "m-basis", evidence: "m-evidence" }}
              summaryRef={errors.summaryRef}
            />
            <Field id="m-title" label="Title" required error={errors.fields.title}>
              {(p) => <textarea {...p} className="input" rows={2} value={form.title} onChange={set("title")} maxLength={1000} />}
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field id="m-type" label="Type" required error={errors.fields.typeFamily}>
                {(p) => (
                  <select
                    {...p}
                    className="input"
                    value={form.typeFamily}
                    onChange={(e) => setForm((f) => ({ ...f, typeFamily: e.target.value as TypeFamily }))}
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="m-year" label="Year" error={errors.fields.year}>
                {(p) => <input {...p} className="input tabular-nums" inputMode="numeric" maxLength={4} value={form.year} onChange={set("year")} />}
              </Field>
              <Field id="m-doi" label="DOI" error={errors.fields.doi}>
                {(p) => (
                  <input {...p} className="input font-mono" autoComplete="off" spellCheck={false} value={form.doi} onChange={set("doi")} maxLength={300} />
                )}
              </Field>
            </div>
            <Field id="m-venue" label="Venue" error={errors.fields.venue}>
              {(p) => <input {...p} className="input" value={form.venue} onChange={set("venue")} maxLength={500} />}
            </Field>
            <Field id="m-authors" label="Authors" error={errors.fields.authorNames}>
              {(p) => <textarea {...p} className="input" rows={2} value={form.authorNames} onChange={set("authorNames")} maxLength={5000} />}
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="m-basis" label="Source of the new values" required error={errors.fields.basis}>
                {(p) => (
                  <select {...p} className="input" value={basis} onChange={(e) => setBasis(e.target.value as DeclaredBasis | "")}>
                    <option value="">Choose a source</option>
                    {DECLARED_BASES.map((b) => (
                      <option key={b} value={b}>
                        {BASIS_LABEL[b]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                id="m-evidence"
                label="Evidence"
                required={basis === "INDEPENDENT"}
                hint="Required for an independent source: a DOI, publisher or repository link, or a note."
                error={errors.fields.evidence}
              >
                {(p) => <input {...p} className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={1000} autoComplete="off" />}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…">
                Save metadata
              </Button>
              <Button onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </Panel>
        </form>
      ) : (
        <Panel className="px-5 py-4">
          <dl className="grid gap-x-6 gap-y-3 text-[15px] sm:grid-cols-[9rem_1fr]">
            <dt className="text-text-muted">Type</dt>
            <dd>{TYPE_LABEL[publication.typeFamily]}</dd>
            <dt className="text-text-muted">Year</dt>
            <dd className="tabular-nums">{publication.year ?? "Year unknown"}</dd>
            <dt className="text-text-muted">Venue</dt>
            <dd>{publication.venue ?? <Missing />}</dd>
            <dt className="text-text-muted">Authors</dt>
            <dd>{publication.authorNamesDisplay ?? <Missing />}</dd>
            <dt className="text-text-muted">DOI</dt>
            <dd>
              <Doi doi={publication.doi} />
            </dd>
            <dt className="text-text-muted">Sources</dt>
            <dd>
              <SourceChips sources={publication.sources} />
            </dd>
            <dt className="text-text-muted">Citations</dt>
            <dd>{publication.scopusCitation ? <ScopusCitationNote citation={publication.scopusCitation} /> : <Missing />}</dd>
            <dt className="text-text-muted">Curation</dt>
            <dd>
              <CurationNote publication={publication} />
            </dd>
          </dl>
        </Panel>
      )}
    </section>
  );
}

const FIELD_LABEL: Record<CuratedField, string> = {
  title: "Title",
  year: "Year",
  venue: "Venue",
  type_family: "Type",
  author_names_display: "Authors",
  doi: "DOI",
};

/** Which fields are curated, each with its declared basis and evidence (decision #125). */
function CurationNote({ publication }: { publication: PublicationDetail }) {
  const entries = (Object.keys(FIELD_LABEL) as CuratedField[]).flatMap((field) => {
    const entry = publication.curation[field];
    return entry ? [{ field, ...entry }] : [];
  });
  if (entries.length === 0) return <>Derived from the source records (OpenAlex, then DBLP, ORCID, Scopus, Web of Science, manual).</>;
  return (
    <>
      <p>Curated fields are kept by synchronization; the others are derived from the source records.</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-[13px]">
        {entries.map((e) => (
          <li key={e.field}>
            <span className="font-medium">{FIELD_LABEL[e.field]}</span>: {BASIS_LABEL[e.basis]}
            {e.evidence && <span className="text-text-muted [overflow-wrap:anywhere]"> — {e.evidence}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

const MATCH_LABEL: Record<SourceRecordSummary["matchMethod"], string> = {
  DOI: "Matched by DOI",
  TITLE_YEAR: "Matched by title and year",
  NEW_PUBLICATION: "Created this publication",
  ADMIN: "Attached by the administrator",
};

function SourceRecordsSection({ publication, onChanged }: { publication: PublicationDetail; onChanged: () => void }) {
  const [record, setRecord] = useState<SourceRecordSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const only = publication.sourceRecords.length < 2;

  async function detach() {
    if (!record) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ publication: PublicationDetail }>(`/admin/source-records/${record.id}/detach`, { method: "POST" });
      setRecord(null);
      setCreated({ id: r.publication.id, title: r.publication.title });
      onChanged();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.code === "SYNC_ALREADY_RUNNING" ? "A synchronization run is in progress. Try again when it has finished." : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="records-heading">
      <SectionTitle id="records-heading">Source records</SectionTitle>
      <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
        Every source that reported this publication. Detach a record that belongs to a different paper; it becomes its own publication without any professor
        links.
      </p>
      {created && (
        <div className="mb-3">
          <Alert tone="success" role="status">
            Detached into{" "}
            <Link href={`/admin/publications/${created.id}`} className="font-serif text-ink underline underline-offset-4">
              {created.title}
            </Link>
            .
          </Alert>
        </div>
      )}
      <Panel>
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption className="sr-only">Source records</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Record</th>
                <th scope="col">Attachment</th>
                <th scope="col">Last seen</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {publication.sourceRecords.map((r) => (
                <tr key={r.id}>
                  <td data-label="Source">
                    <SourceChip source={r.source} />
                  </td>
                  <td className="no-label min-w-[14rem]">
                    <p className="font-serif">{r.title}</p>
                    <p className="text-[13px] leading-5 text-text-muted">
                      {[TYPE_LABEL[r.typeFamily], r.venue, r.year ?? "Year unknown"].filter(Boolean).join(" · ")}
                    </p>
                    <p className="font-mono text-[12px] leading-5 text-text-muted [overflow-wrap:anywhere]">{r.externalId}</p>
                    {r.doi && <Doi doi={r.doi} />}
                  </td>
                  <td data-label="Attachment" className="text-[13px] max-w-[22rem]">
                    <p className="font-medium">{MATCH_LABEL[r.matchMethod]}</p>
                    {r.matchDetail && <p className="text-text-muted [overflow-wrap:anywhere]">{r.matchDetail}</p>}
                    {r.entryBasis && (
                      <p className="text-text-muted [overflow-wrap:anywhere]">
                        Entry: {BASIS_LABEL[r.entryBasis]}
                        {r.entryEvidence && ` — ${r.entryEvidence}`}
                      </p>
                    )}
                  </td>
                  <td data-label="Last seen" className="text-[13px] whitespace-nowrap">
                    {r.source === "MANUAL" ? "Manual entry" : formatDate(r.lastSeenAt)}
                  </td>
                  <td className="no-label md:w-px">
                    <Button
                      variant="quiet"
                      compact
                      icon={<Unlink aria-hidden size={16} />}
                      disabled={only}
                      title={only ? "The only source record of a publication cannot be detached" : undefined}
                      onClick={() => setRecord(r)}
                    >
                      Detach
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <ConfirmDialog
        open={record !== null}
        title="Detach this source record?"
        confirmLabel="Detach"
        busyLabel="Detaching…"
        busy={busy}
        error={err}
        onConfirm={() => void detach()}
        onClose={() => {
          setRecord(null);
          setErr(null);
        }}
      >
        {record && (
          <>
            <p>
              The {SOURCE_LABEL[record.source]} record “<span className="font-serif">{record.title}</span>” becomes a separate publication. Professors’
              decisions on this publication stay here; the next synchronization links the new publication to its professor as pending.
            </p>
            <p className="text-[13px] text-text-muted">Not available while a synchronization run is in progress.</p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

function RelationshipsSection({ publication }: { publication: PublicationDetail }) {
  return (
    <section aria-labelledby="rel-heading">
      <SectionTitle id="rel-heading">Professors</SectionTitle>
      <Panel>
        {publication.relationships.length === 0 ? (
          <EmptyState>No professor is linked to this publication.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">Professor relationships</caption>
              <thead>
                <tr>
                  <th scope="col">Professor</th>
                  <th scope="col">Status</th>
                  <th scope="col">Found through</th>
                  <th scope="col">Decided</th>
                </tr>
              </thead>
              <tbody>
                {publication.relationships.map((r) => (
                  <tr key={r.id}>
                    <td className="no-label">
                      <Link href={`/admin/professors/${r.professor.id}`} className="text-ink hover:underline underline-offset-4">
                        {r.professor.name}
                      </Link>
                      {!r.professor.isActive && <span className="ml-2 text-[13px] text-text-muted">(inactive)</span>}
                    </td>
                    <td data-label="Status">
                      <StatusChip status={r.status} />
                    </td>
                    <td data-label="Found through" className="text-[13px]">
                      {r.origin === "MANUAL" ? (
                        "Added by the professor"
                      ) : r.discoveredViaIdentity ? (
                        <span>
                          {SOURCE_LABEL[r.discoveredViaIdentity.source]} <span className="font-mono">{r.discoveredViaIdentity.externalId}</span>
                        </span>
                      ) : (
                        "Synchronization"
                      )}
                    </td>
                    <td data-label="Decided" className="text-[13px] whitespace-nowrap">
                      {r.decidedAt ? formatDateTime(r.decidedAt) : <Missing />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}

function CandidatesSection({ publication }: { publication: PublicationDetail }) {
  if (publication.duplicateCandidates.length === 0) return null;
  return (
    <section aria-labelledby="cand-heading">
      <SectionTitle
        id="cand-heading"
        actions={
          <Link href="/admin/duplicates" className="text-[15px] text-ink hover:underline underline-offset-4">
            Resolve in duplicate candidates
          </Link>
        }
      >
        Possible duplicates
      </SectionTitle>
      <Panel>
        <ul className="divide-y divide-border">
          {publication.duplicateCandidates.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip status={c.status} />
                {c.otherPublication ? (
                  <Link href={`/admin/publications/${c.otherPublication.id}`} className="font-serif text-ink hover:underline underline-offset-4">
                    {c.otherPublication.title}
                  </Link>
                ) : (
                  <span className="text-text-muted">The other publication was merged away</span>
                )}
              </div>
              <p className="text-[13px] text-text-muted">{c.reason}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

function SuppressionSection({ publication, onSaved }: { publication: PublicationDetail; onSaved: (p: PublicationDetail) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suppress = publication.status === "ACTIVE";

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      const { publication: saved } = await api<{ publication: PublicationDetail }>(`/admin/publications/${publication.id}/status`, {
        method: "PATCH",
        body: { status: suppress ? "SUPPRESSED" : "ACTIVE", expectedStatus: publication.status },
      });
      onSaved(saved);
      setOpen(false);
      toast(suppress ? "Publication suppressed." : "Publication restored.");
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "STATUS_CONFLICT" ? "The status was changed meanwhile. Reload the page and try again." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="supp-heading" className="max-w-3xl">
      <SectionTitle id="supp-heading">{suppress ? "Suppress" : "Restore"}</SectionTitle>
      <Panel className="flex flex-col items-start gap-3 px-5 py-5">
        <p>
          {suppress
            ? "Suppress an incorrect publication instead of deleting it: it is hidden from professors and analytics and never linked again automatically. Records and decisions are kept."
            : "Restore the publication: it becomes visible again with its existing relationships. No new relationships are created."}
        </p>
        <Button
          variant={suppress ? "danger" : "primary"}
          icon={suppress ? <EyeOff aria-hidden size={18} /> : <Eye aria-hidden size={18} />}
          onClick={() => setOpen(true)}
        >
          {suppress ? "Suppress publication" : "Restore publication"}
        </Button>
      </Panel>
      <ConfirmDialog
        open={open}
        title={suppress ? "Suppress this publication?" : "Restore this publication?"}
        confirmLabel={suppress ? "Suppress" : "Restore"}
        busyLabel="Saving…"
        danger={suppress}
        busy={busy}
        error={err}
        onConfirm={() => void apply()}
        onClose={() => {
          setOpen(false);
          setErr(null);
        }}
      >
        <p className="font-serif">{publication.title}</p>
        <p>
          {suppress
            ? "Professors will no longer see it, and it is excluded from analytics. You can restore it later."
            : "Professors linked to it will see it again with their previous decisions."}
        </p>
      </ConfirmDialog>
    </section>
  );
}
