"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plus, Power, Trash2 } from "lucide-react";
import { StatusChip } from "./chips";
import { ConfirmDialog } from "./dialog";
import { ErrorSummary, Field, useFormErrors } from "./form";
import { useToast } from "./toast";
import { Alert, Button, EmptyState, ExternalProfileLink, Panel, SectionTitle } from "./ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber, SOURCE_LABEL } from "@/lib/format";
import type { AddedBy, Identity, IdentityPreview, IdentitySource, IdentitySyncStart, IdentitySyncStatus } from "@/lib/types";

/** What the professor is told after adding an identity (#171). */
export function syncStartMessage(sync: IdentitySyncStart): string {
  switch (sync.status) {
    case "STARTED":
      return "Synchronization started: new publications will appear under Pending.";
    case "QUEUED":
      return "Synchronization is queued: it starts automatically when the current synchronization finishes.";
    case "NOT_STARTED":
      return `Not synchronized yet: ${sync.reason}`;
  }
}

function addedByLabel(addedBy: AddedBy, audience: "ADMIN" | "PROFESSOR"): string {
  switch (addedBy.kind) {
    case "PROFESSOR":
      return audience === "PROFESSOR" ? "You" : `Added by professor${addedBy.name ? ` (${addedBy.name})` : ""}`;
    case "ADMIN":
      return audience === "PROFESSOR" ? "The administrator" : "Added by administrator";
    case "ADMIN_UNRECORDED":
      return audience === "PROFESSOR" ? "The administrator" : "Added by administrator (not recorded)";
  }
}

/** The latest synchronization of an identity, or why it has none (#171). */
function SyncStatusCell({ status }: { status: IdentitySyncStatus }) {
  switch (status.state) {
    case "SYNCHRONIZED":
      return <span>Synchronized{status.at && <span className="block text-text-muted"><DateTimeLines value={status.at} /></span>}</span>;
    case "RUNNING":
      return <span>Synchronizing now</span>;
    case "FAILED":
      return (
        <span className="text-danger">
          Failed{status.at && <span className="block text-text-muted"><DateTimeLines value={status.at} /></span>}
          {status.message && <span className="block text-text">{status.message}</span>}
          <span className="block text-text-muted">Retried by the next synchronization.</span>
        </span>
      );
    case "NOT_CONFIGURED":
      return <span className="text-text-muted">Not synchronized: the provider is not configured{status.message ? ` (${status.message})` : ""}</span>;
    case "QUEUED":
      return <span>Queued: starts after the current synchronization</span>;
    case "WAITING_FOR_PROVIDER":
      return <span className="text-text-muted">Waiting for the provider’s API access</span>;
    case "NEVER":
      return <span className="text-text-muted">{status.includedInNextRun ? "Not yet synchronized: included in the next synchronization run" : "Not yet synchronized"}</span>;
  }
}

const SOURCE_HINT: Record<IdentitySource, string> = {
  OPENALEX: "OpenAlex author ID, e.g. A5023888391 or https://openalex.org/A5023888391",
  DBLP: "DBLP person ID (PID), e.g. v/MosheYVardi or https://dblp.org/pid/v/MosheYVardi",
  ORCID: "ORCID iD, e.g. 0000-0002-0661-5773",
  SCOPUS: "Scopus Author ID, e.g. 7004212771, or the author’s Scopus profile URL",
  WOS: "Web of Science ResearcherID, e.g. A-1009-2008, or the author’s Web of Science record URL",
};

/**
 * Licensed providers whose identities can also be verified manually from the author's public
 * profile when their API is not configured (decision #118).
 */
const PROFILE_EVIDENCE: Partial<Record<IdentitySource, { provider: string; idLabel: string; urlLabel: string; placeholder: string }>> = {
  SCOPUS: {
    provider: "Scopus",
    idLabel: "Scopus Author ID",
    urlLabel: "Scopus profile URL",
    placeholder: "https://www.scopus.com/authid/detail.uri?authorId=…",
  },
  WOS: {
    provider: "Web of Science",
    idLabel: "Web of Science ResearcherID",
    urlLabel: "Web of Science record URL",
    placeholder: "https://www.webofscience.com/wos/author/record/…",
  },
};

/**
 * External identities of one professor, for the administrator (any professor) and for the professor
 * (their own, decision #171) — the same list, actions and add flow over `basePath`:
 * `/admin/professors/:id/identities` or `/me/identities`. The server scopes every operation; the
 * professor's routes take the professor from the session.
 */
export function IdentitiesSection({
  identities,
  basePath,
  audience,
  onChanged,
}: {
  identities: Identity[];
  basePath: string;
  audience: "ADMIN" | "PROFESSOR";
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<{ identity: Identity; kind: "toggle" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply() {
    if (!action) return;
    setBusy(true);
    setErr(null);
    const { identity, kind } = action;
    const path = `${basePath}/${identity.id}`;
    try {
      const r =
        kind === "delete"
          ? await api<{ pendingLinksRemoved: number }>(path, { method: "DELETE" })
          : await api<{ pendingLinksRemoved: number }>(path, { method: "PATCH", body: { isActive: !identity.isActive } });
      const removed = r.pendingLinksRemoved ? ` ${formatNumber(r.pendingLinksRemoved)} pending publications found through it were removed.` : "";
      toast(`${kind === "delete" ? "Identity removed." : identity.isActive ? "Identity deactivated." : "Identity reactivated."}${removed}`);
      setAction(null);
      onChanged();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="identities-heading">
      <SectionTitle
        id="identities-heading"
        actions={
          !adding && (
            <Button compact icon={<Plus aria-hidden size={16} />} onClick={() => setAdding(true)}>
              Add identity
            </Button>
          )
        }
      >
        {audience === "PROFESSOR" ? "My identities" : "External identities"}
      </SectionTitle>
      <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
        {audience === "PROFESSOR"
          ? "Your publications are collected through these identities. Add each of your OpenAlex, DBLP, ORCID, Scopus or Web of Science identities: it is checked with its source (or, for Scopus and Web of Science without API access, from your public profile), becomes active at once and is synchronized right away. New publications then appear under Pending for you to verify. To correct an identifier, remove it and add the right one."
          : "Synchronization collects publications through these identities. A professor may have several per source, and may add their own. An identity is saved after it is checked with its source, or — for Scopus and Web of Science without API access — after it is verified from the author’s public profile. Synchronization checks each identity with its source again before accepting publications."}
      </p>
      <div className="flex flex-col gap-4">
        {adding && (
          <AddIdentity
            basePath={basePath}
            audience={audience}
            onCancel={() => setAdding(false)}
            onSaved={(sync) => {
              setAdding(false);
              toast(sync ? `Identity saved. ${syncStartMessage(sync)}` : "Identity saved.", sync?.status === "NOT_STARTED" ? "danger" : undefined);
              onChanged();
            }}
          />
        )}
        <Panel>
          {identities.length === 0 ? (
            <EmptyState>
              {audience === "PROFESSOR"
                ? "No identities yet. Add your OpenAlex, DBLP, ORCID, Scopus or Web of Science identity so your publications can be collected."
                : "No identities yet. Add an OpenAlex, DBLP, ORCID, Scopus or Web of Science identity so this professor’s publications can be collected."}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">External identities</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Identifier</th>
                    <th scope="col">Verified</th>
                    <th scope="col">Added by</th>
                    <th scope="col">Status</th>
                    <th scope="col">Synchronization</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {identities.map((identity) => (
                    <tr key={identity.id}>
                      <td data-label="Source">{SOURCE_LABEL[identity.source]}</td>
                      <td data-label="Identifier">
                        <IdentifierCell value={identity.externalId} />
                      </td>
                      <td data-label="Verified" className="text-[13px]">
                        <DateTimeLines value={identity.verifiedAt} />
                        {identity.verificationMethod === "MANUAL_PROFILE" && (
                          <span className="block text-text-muted">
                            Manually, from the{" "}
                            {identity.verificationEvidenceUrl ? (
                              <ExternalProfileLink href={identity.verificationEvidenceUrl}>profile</ExternalProfileLink>
                            ) : (
                              "profile"
                            )}
                          </span>
                        )}
                      </td>
                      <td data-label="Added by" className="text-[13px]" data-added-by={identity.addedBy.kind}>
                        {addedByLabel(identity.addedBy, audience)}
                      </td>
                      <td data-label="Status">
                        <StatusChip status={identity.isActive ? "ACTIVE" : "INACTIVE"} />
                      </td>
                      <td data-label="Synchronization" className="text-[13px]" data-sync-state={identity.syncStatus.state}>
                        <SyncStatusCell status={identity.syncStatus} />
                      </td>
                      <td className="no-label md:w-px">
                        <div className="flex flex-wrap gap-1 md:justify-end">
                          <Button variant="quiet" compact icon={<Power aria-hidden size={16} />} onClick={() => setAction({ identity, kind: "toggle" })}>
                            {identity.isActive ? "Deactivate" : "Reactivate"}
                          </Button>
                          <Button
                            variant="quiet"
                            compact
                            icon={<Trash2 aria-hidden size={16} />}
                            onClick={() => setAction({ identity, kind: "delete" })}
                            className="text-danger"
                          >
                            Remove
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      <ConfirmDialog
        open={action !== null}
        title={
          action?.kind === "delete"
            ? `Remove ${action ? SOURCE_LABEL[action.identity.source] : ""} identity?`
            : action?.identity.isActive
              ? "Deactivate identity?"
              : "Reactivate identity?"
        }
        confirmLabel={action?.kind === "delete" ? "Remove" : action?.identity.isActive ? "Deactivate" : "Reactivate"}
        busyLabel="Saving…"
        danger={action?.kind === "delete" || !!action?.identity.isActive}
        busy={busy}
        error={err}
        onConfirm={() => void apply()}
        onClose={() => {
          setAction(null);
          setErr(null);
        }}
      >
        {action && (
          <p>
            <span className="font-mono text-[13px]">{action.identity.externalId}</span>:{" "}
            {action.kind === "delete"
              ? "Pending publications found only through this identity are removed. Approved and rejected publications are kept."
              : action.identity.isActive
                ? "It will no longer be synchronized, and pending publications found through it are removed. Approved and rejected publications are kept."
                : "It will be synchronized again from the next run."}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

function AddIdentity({
  basePath,
  audience,
  onCancel,
  onSaved,
}: {
  basePath: string;
  audience: "ADMIN" | "PROFESSOR";
  onCancel: () => void;
  /** With the synchronization start for a professor's identity (#171); undefined for the administrator. */
  onSaved: (sync?: IdentitySyncStart) => void;
}) {
  const [source, setSource] = useState<IdentitySource>("OPENALEX");
  const [externalId, setExternalId] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | "manual" | null>(null);
  const errors = useFormErrors();
  /** Professors confirm that they checked the public profile before a manual registration (#171). */
  const [checkedProfile, setCheckedProfile] = useState(false);

  const evidence = PROFILE_EVIDENCE[source];

  /** Scopus or Web of Science without API credentials: the administrator verifies from the public profile (decision #118). */
  async function saveManually() {
    if (!evidence) return;
    const local: Record<string, string> = {};
    if (!externalId.trim()) local.externalId = `Enter the ${evidence.idLabel}`;
    if (!evidenceUrl.trim()) local.evidenceUrl = `Enter the author’s ${evidence.urlLabel}`;
    if (audience === "PROFESSOR" && !checkedProfile) local.checkedProfile = "Confirm that you checked the profile and that it is yours";
    if (Object.keys(local).length > 0) return errors.setLocal(local);
    errors.clear();
    setBusy("manual");
    try {
      const body = audience === "PROFESSOR" ? { source, externalId, evidenceUrl, checkedProfile: true } : { source, externalId, evidenceUrl };
      const saved = await api<{ sync?: IdentitySyncStart }>(`${basePath}/manual`, { method: "POST", body });
      onSaved(saved.sync);
    } catch (error) {
      errors.fromError(error, { INVALID_IDENTIFIER: "externalId", INVALID_EVIDENCE: "evidenceUrl", EVIDENCE_MISMATCH: "evidenceUrl", PREVIEW_AVAILABLE: "externalId" });
      setBusy(null);
    }
  }

  async function runPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!externalId.trim()) return errors.setLocal({ externalId: "Enter the identifier" });
    errors.clear();
    setPreview(null);
    setBusy("preview");
    try {
      setPreview(await api<IdentityPreview>(`${basePath}/preview`, { method: "POST", body: { source, externalId } }));
    } catch (error) {
      errors.fromError(error, { INVALID_IDENTIFIER: "externalId", IDENTITY_NOT_FOUND: "externalId", IDENTITY_INVALID: "externalId" });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!preview) return;
    setBusy("save");
    try {
      const saved = await api<{ sync?: IdentitySyncStart }>(basePath, { method: "POST", body: { previewToken: preview.previewToken } });
      onSaved(saved.sync);
    } catch (error) {
      errors.fromError(error);
      setBusy(null);
    }
  }

  const p = preview?.preview;
  // The administrator learns which professor holds an identity; a professor only whether it is taken (#171).
  const raw = preview?.alreadyAssigned;
  const assigned = raw ? (typeof raw === "string" ? raw : raw.sameProfessor ? "YOURS" : "ANOTHER_PROFESSOR") : null;
  const self = audience === "PROFESSOR";
  return (
    <Panel className="max-w-3xl px-5 py-5">
      <form noValidate onSubmit={runPreview} className="flex flex-col gap-4">
        <h3 className="text-[15px] font-semibold">Add identity</h3>
        <ErrorSummary
          errors={errors.fields}
          formError={errors.form}
          labels={{ externalId: "Identifier", source: "Source", evidenceUrl: evidence?.urlLabel ?? "Profile URL", checkedProfile: "Profile check" }}
          fieldIds={{ externalId: "id-value", source: "id-source", evidenceUrl: "id-evidence", checkedProfile: "id-checked" }}
          summaryRef={errors.summaryRef}
        />
        <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
          <Field id="id-source" label="Source" required>
            {(f) => (
              <select
                {...f}
                className="input"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as IdentitySource);
                  setEvidenceUrl("");
                  setCheckedProfile(false);
                  setPreview(null);
                }}
              >
                <option value="OPENALEX">OpenAlex</option>
                <option value="DBLP">DBLP</option>
                <option value="ORCID">ORCID</option>
                <option value="SCOPUS">Scopus</option>
                <option value="WOS">Web of Science</option>
              </select>
            )}
          </Field>
          <Field id="id-value" label="Identifier" required hint={SOURCE_HINT[source]} error={errors.fields.externalId}>
            {(f) => (
              <input
                {...f}
                className="input font-mono"
                autoComplete="off"
                spellCheck={false}
                value={externalId}
                onChange={(e) => {
                  setExternalId(e.target.value);
                  setPreview(null);
                }}
              />
            )}
          </Field>
        </div>
        {evidence && (
          <Field
            id="id-evidence"
            label={evidence.urlLabel}
            hint={
              source === "WOS"
                ? `Needed to save without the Web of Science API: open the Web of Science record, confirm it is ${self ? "yours" : "this professor"}, and paste its URL (it must contain the ResearcherID). Each synchronization accepts only documents that list this ResearcherID among their authors.`
                : `Needed to save without the Scopus API: open the Scopus profile, confirm it is ${self ? "yours" : "this professor"}, and paste its URL. The next synchronization checks the Author ID with Scopus before accepting any publication.`
            }
            error={errors.fields.evidenceUrl}
          >
            {(f) => (
              <input
                {...f}
                className="input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={evidence.placeholder}
                value={evidenceUrl}
                onChange={(e) => setEvidenceUrl(e.target.value)}
              />
            )}
          </Field>
        )}
        {evidence && self && (
          <div className="flex flex-col gap-1">
            <label className="inline-flex cursor-pointer items-start gap-2 text-[15px]">
              <input
                id="id-checked"
                type="checkbox"
                className="mt-1 size-4 cursor-pointer accent-[var(--ink)]"
                checked={checkedProfile}
                aria-invalid={errors.fields.checkedProfile ? true : undefined}
                onChange={(e) => setCheckedProfile(e.target.checked)}
              />
              <span>
                I opened this {evidence.provider} profile and checked that it is mine (identifier <span className="font-mono text-[13px]">{externalId.trim() || "…"}</span>
                {evidenceUrl.trim() && (
                  <>
                    {", "}
                    <span className="[overflow-wrap:anywhere]">{evidenceUrl.trim()}</span>
                  </>
                )}
                ).
              </span>
            </label>
            {errors.fields.checkedProfile && <p className="text-[13px] text-danger">{errors.fields.checkedProfile}</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy === "preview"} loadingLabel="Checking with the source…" disabled={busy === "save" || busy === "manual"}>
            Check identity
          </Button>
          {evidence && (
            <Button onClick={() => void saveManually()} loading={busy === "manual"} loadingLabel="Saving…" disabled={busy === "preview" || busy === "save"}>
              {self ? "Save from my profile" : "Save as verified from profile"}
            </Button>
          )}
          <Button variant="quiet" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      </form>

      {p && preview && (
        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4" aria-live="polite">
          <h4 className="text-[15px] font-semibold">Is this the right person?</h4>
          <dl className="grid gap-x-6 gap-y-2 text-[15px] sm:grid-cols-[10rem_1fr]">
            <dt className="text-text-muted">Name at source</dt>
            <dd>{p.displayName ?? p.name ?? "–"}</dd>
            <dt className="text-text-muted">Identifier</dt>
            <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">{p.externalId}</dd>
            {p.worksCount !== undefined && (
              <>
                <dt className="text-text-muted">Works at source</dt>
                <dd className="tabular-nums">{formatNumber(p.worksCount)}</dd>
              </>
            )}
            {p.documentCount !== undefined && p.documentCount !== null && (
              <>
                <dt className="text-text-muted">{p.source === "WOS" ? "Documents found by ResearcherID" : "Documents at source"}</dt>
                <dd className="tabular-nums">{formatNumber(p.documentCount)}</dd>
              </>
            )}
            {p.orcid && (
              <>
                <dt className="text-text-muted">ORCID</dt>
                <dd className="font-mono text-[13px]">{p.orcid}</dd>
              </>
            )}
            <dt className="text-text-muted">Profile</dt>
            <dd>
              <ExternalProfileLink href={p.profileUrl}>Open at {SOURCE_LABEL[p.source]}</ExternalProfileLink>
            </dd>
          </dl>
          {p.recentWorks && p.recentWorks.length > 0 && (
            <div>
              <p className="text-[13px] font-medium text-text-muted">Recent works</p>
              <ul className="mt-1 list-disc pl-5 text-[15px]">
                {p.recentWorks.map((w, i) => (
                  <li key={i}>
                    <span className="font-serif">{w.title}</span>
                    {w.year ? <span className="text-text-muted"> · {w.year}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.warning && <Alert tone="warning">{p.warning}</Alert>}
          {assigned && (
            <Alert tone={assigned === "YOURS" ? "info" : "danger"}>
              {assigned === "YOURS"
                ? self
                  ? "This identity is already saved on your profile."
                  : "This identity is already saved for this professor."
                : self
                  ? "This identity already belongs to another professor and cannot be added. Contact the administrator if you think it is yours."
                  : "This identity already belongs to another professor and cannot be saved here."}
            </Alert>
          )}
          <div>
            <Button variant="primary" onClick={() => void save()} loading={busy === "save"} loadingLabel="Saving…" disabled={!!assigned || busy === "preview"}>
              Save identity
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** "30 Oct 2026, 22:46 IST" that may break only between the date and the time, never inside either. */
function DateTimeLines({ value }: { value: string | null }) {
  const text = formatDateTime(value);
  const comma = text.indexOf(", ");
  if (comma < 0) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <>
      <span className="whitespace-nowrap">{text.slice(0, comma + 1)}</span> <span className="whitespace-nowrap">{text.slice(comma + 2)}</span>
    </>
  );
}

/**
 * An identifier kept on one line (long numeric IDs never break mid-number), with a quiet copy
 * control. Success and failure are both reported visibly; when the browser refuses clipboard
 * access, the identifier is selected so it can be copied with the keyboard.
 */
function IdentifierCell({ value }: { value: string }) {
  const toast = useToast();
  const textRef = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("Identifier copied.");
    } catch {
      const selection = window.getSelection();
      if (textRef.current && selection) selection.selectAllChildren(textRef.current);
      toast("The browser did not allow copying. The identifier is selected: press Ctrl+C (⌘C on a Mac) to copy it.", "danger");
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span ref={textRef} className="font-mono text-[13px] whitespace-nowrap tabular-nums select-all">
        {value}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy identifier ${value}`}
        title="Copy identifier"
        className="-my-2 inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-surface-sunken hover:text-text active:bg-surface-sunken"
      >
        {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
      </button>
    </span>
  );
}
