"use client";

import Link from "next/link";
import { useState } from "react";
import { SourceChips, StatusChip } from "@/components/chips";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { Alert, Button, ButtonLink, Doi, PageHeader, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import { TYPE_LABEL, TYPE_OPTIONS } from "@/lib/format";
import type { ManualResult, TypeFamily } from "@/lib/types";

/**
 * Manual publication addition (Project_plan.md §12): metadata only, through the backend's
 * matching pipeline. The result explains whether an existing publication was reused.
 */

const LABELS = { title: "Title", typeFamily: "Type", doi: "DOI", year: "Year", venue: "Venue", authorNames: "Authors" };
const IDS = { title: "title", typeFamily: "type", doi: "doi", year: "year", venue: "venue", authorNames: "authors" };

const OUTCOME: Record<ManualResult["match"]["outcome"], string> = {
  NEW_PUBLICATION: "No existing publication matched, so a new one was created.",
  MATCHED_DOI: "It matched an existing publication by DOI, so that publication was reused.",
  MATCHED_TITLE_YEAR: "It matched an existing publication by title, year and type, so that publication was reused.",
  UPDATED_EXISTING: "It updated an existing record.",
};

const RELATIONSHIP: Record<ManualResult["match"]["relationship"], string> = {
  CREATED: "It is now in your approved publications.",
  UPGRADED: "It was already linked to you and is now approved.",
  UNCHANGED: "It was already in your approved publications.",
};

export default function AddPublicationPage() {
  const [form, setForm] = useState({ title: "", typeFamily: "" as TypeFamily | "", doi: "", year: "", venue: "", authorNames: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualResult | null>(null);
  const errors = useFormErrors();
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.title.trim()) local.title = "Enter the publication title";
    if (!form.typeFamily) local.typeFamily = "Choose the publication type";
    if (form.year && !/^\d{4}$/.test(form.year.trim())) local.year = "Enter a four-digit year";
    if (Object.keys(local).length) return errors.setLocal(local);
    errors.clear();
    setBusy(true);
    try {
      const body = {
        title: form.title,
        typeFamily: form.typeFamily,
        doi: form.doi.trim() || null,
        year: form.year.trim() ? Number(form.year) : null,
        venue: form.venue.trim() || null,
        authorNames: form.authorNames.trim() || null,
      };
      setResult(await api<ManualResult>("/me/publications", { method: "POST", body }));
    } catch (error) {
      errors.fromError(error, { INVALID_DOI: "doi", INVALID_TITLE: "title" });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const p = result.item.publication;
    return (
      <>
        <PageHeader title="Publication added" />
        <div className="flex max-w-3xl flex-col gap-4">
          <Alert tone="success" role="status" title={RELATIONSHIP[result.match.relationship]}>
            {OUTCOME[result.match.outcome]}
            {result.match.candidatesCreated > 0 && " A similar publication exists; the administrator will check whether they are the same."}
          </Alert>
          <Panel className="px-5 py-4">
            <p className="font-serif text-lg leading-7 font-medium">{p.title}</p>
            <p className="mt-1 text-[13px] text-text-muted">
              {[TYPE_LABEL[p.typeFamily], p.venue, p.year ?? "Year unknown", p.authorNamesDisplay].filter(Boolean).join(" · ")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip status={result.item.status} />
              <SourceChips sources={p.sources} />
              {p.doi && <Doi doi={p.doi} />}
            </div>
          </Panel>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/professor/publications" variant="primary">
              View my publications
            </ButtonLink>
            <Button
              onClick={() => {
                setResult(null);
                setForm({ title: "", typeFamily: "", doi: "", year: "", venue: "", authorNames: "" });
              }}
            >
              Add another
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add publication"
        description="Add a publication the sources missed. It is matched against existing publications, so an existing one is reused instead of duplicated. Only metadata is stored — no abstracts, full text or files."
      />
      <form noValidate onSubmit={submit} className="flex max-w-3xl flex-col gap-6">
        <ErrorSummary errors={errors.fields} formError={errors.form} labels={LABELS} fieldIds={IDS} summaryRef={errors.summaryRef} />
        <fieldset className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-5 pt-3 pb-5">
          <legend className="px-1 text-lg font-semibold">Publication</legend>
          <Field id={IDS.title} label="Title" required error={errors.fields.title}>
            {(p) => <input {...p} className="input" value={form.title} onChange={set("title")} maxLength={1000} />}
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id={IDS.typeFamily} label="Type" required error={errors.fields.typeFamily}>
              {(p) => (
                <select {...p} className="input" value={form.typeFamily} onChange={set("typeFamily")}>
                  <option value="">Choose a type</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={IDS.year} label="Year" error={errors.fields.year}>
              {(p) => <input {...p} className="input tabular-nums" inputMode="numeric" value={form.year} onChange={set("year")} maxLength={4} />}
            </Field>
          </div>
          <Field id={IDS.venue} label="Venue" hint="Journal or conference name." error={errors.fields.venue}>
            {(p) => <input {...p} className="input" value={form.venue} onChange={set("venue")} maxLength={500} />}
          </Field>
          <Field id={IDS.authorNames} label="Authors" hint="As printed, e.g. “A. Kumar, B. Singh”." error={errors.fields.authorNames}>
            {(p) => <textarea {...p} className="input" rows={2} value={form.authorNames} onChange={set("authorNames")} maxLength={5000} />}
          </Field>
        </fieldset>
        <fieldset className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-5 pt-3 pb-5">
          <legend className="px-1 text-lg font-semibold">Identifiers</legend>
          <Field
            id={IDS.doi}
            label="DOI"
            hint="Optional. For example 10.1145/3442188.3445922 or https://doi.org/…; it is the most reliable way to match an existing publication."
            error={errors.fields.doi}
          >
            {(p) => <input {...p} className="input font-mono" value={form.doi} onChange={set("doi")} maxLength={300} autoComplete="off" spellCheck={false} />}
          </Field>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Adding…">
            Add publication
          </Button>
          <Link href="/professor/publications" className="text-[15px] text-ink hover:underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
