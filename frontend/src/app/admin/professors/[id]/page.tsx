"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Mail, Plus, Power, Trash2 } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { InvitationNotice } from "@/components/invitation-status";
import { useToast } from "@/components/toast";
import { Alert, Button, EmptyState, ExternalProfileLink, LoadError, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber, SOURCE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { AccountResult, Identity, IdentityPreview, IdentitySource, InvitationStatus, ProfessorDetail } from "@/lib/types";

/** One professor: profile, activation, login account and external identities (Phase 9). */
export default function ProfessorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const path = `/admin/professors/${id}`;
  const { data, error, reload, setData } = useResource<ProfessorDetail>(path, (signal) =>
    api<{ professor: ProfessorDetail }>(path, { signal }).then((r) => r.professor),
  );

  if (error && !data) {
    return (
      <>
        <PageHeader title="Professor" breadcrumbs={[{ href: "/admin/professors", label: "Professors" }]} />
        <LoadError error={error} onRetry={error instanceof ApiError && error.status === 404 ? undefined : () => void reload()} />
      </>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-label="Loading professor" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title={data.name}
        breadcrumbs={[{ href: "/admin/professors", label: "Professors" }]}
        description={[data.designation, data.department].filter(Boolean).join(" · ") || undefined}
        actions={<StatusChip status={data.isActive ? "ACTIVE" : "INACTIVE"} />}
      />
      <div className="flex flex-col gap-10">
        <ProfileSection professor={data} onSaved={setData} />
        <IdentitiesSection professor={data} onChanged={() => void reload()} />
        <StatusSection professor={data} onSaved={setData} />
      </div>
    </>
  );
}

function ProfileSection({ professor, onSaved }: { professor: ProfessorDetail; onSaved: (p: ProfessorDetail) => void }) {
  const toast = useToast();
  const initial = {
    name: professor.name,
    department: professor.department ?? "",
    designation: professor.designation ?? "",
    email: professor.account?.email ?? "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Result of the last emailing of sign-in details (never the password itself, #102).
  const [notice, setNotice] = useState<{ status: InvitationStatus; email: string } | null>(null);
  const [resending, setResending] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [newAccountEmail, setNewAccountEmail] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const errors = useFormErrors();
  const accountErrors = useFormErrors();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const changed = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => {
    // The saved values become the new baseline.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm({ name: professor.name, department: professor.department ?? "", designation: professor.designation ?? "", email: professor.account?.email ?? "" });
  }, [professor]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return errors.setLocal({ name: "Enter the professor's name" });
    errors.clear();
    setBusy(true);
    try {
      const body: Record<string, string | null> = { name: form.name, department: form.department || null, designation: form.designation || null };
      if (professor.account && form.email !== professor.account.email) body.email = form.email;
      const { professor: saved, invitation } = await api<AccountResult>(`/admin/professors/${professor.id}`, { method: "PATCH", body });
      onSaved(saved);
      // A new login email for an account that is not yet activated gets new sign-in details.
      if (invitation) setNotice({ status: invitation.status, email: saved.account?.email ?? form.email });
      toast("Profile saved.");
    } catch (error) {
      errors.fromError(error, { EMAIL_IN_USE: "email" });
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!newAccountEmail.trim()) return accountErrors.setLocal({ email: "Enter the login email" });
    accountErrors.clear();
    setAccountBusy(true);
    try {
      const r = await api<AccountResult>(`/admin/professors/${professor.id}/account`, {
        method: "POST",
        body: { email: newAccountEmail },
      });
      if (r.invitation) setNotice({ status: r.invitation.status, email: r.professor.account?.email ?? newAccountEmail });
      onSaved(r.professor);
    } catch (error) {
      accountErrors.fromError(error, { EMAIL_IN_USE: "email" });
    } finally {
      setAccountBusy(false);
    }
  }

  async function resend() {
    setResendBusy(true);
    setResendError(null);
    try {
      const r = await api<AccountResult>(`/admin/professors/${professor.id}/account/invitation`, { method: "POST" });
      onSaved(r.professor);
      if (r.invitation) setNotice({ status: r.invitation.status, email: r.professor.account?.email ?? "" });
      setResending(false);
    } catch (e) {
      setResendError(errorMessage(e));
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <section aria-labelledby="profile-heading">
      <SectionTitle id="profile-heading">Profile and account</SectionTitle>
      <div className="flex flex-col gap-4">
        {notice && (
          <div className="max-w-3xl">
            <InvitationNotice status={notice.status} email={notice.email} />
          </div>
        )}
        {professor.account && !professor.account.activated && (
          <Panel className="flex max-w-3xl flex-col items-start gap-3 px-5 py-5">
            <div>
              <h3 className="text-[15px] font-semibold">Not activated yet</h3>
              <p className="text-[13px] leading-5 text-text-muted">
                The professor has not yet replaced the emailed temporary password.
                {professor.account.temporaryPasswordExpiresAt && ` It expires ${formatDateTime(professor.account.temporaryPasswordExpiresAt)}.`} Resending
                emails a new temporary password; the previous one stops working.
              </p>
            </div>
            <Button icon={<Mail aria-hidden size={18} />} onClick={() => setResending(true)} disabled={!professor.isActive}>
              Resend sign-in email
            </Button>
            {!professor.isActive && <p className="text-[13px] text-text-muted">Reactivate the professor first.</p>}
          </Panel>
        )}
        <ConfirmDialog
          open={resending}
          title="Resend sign-in details?"
          confirmLabel="Send"
          busyLabel="Sending…"
          busy={resendBusy}
          error={resendError}
          onConfirm={() => void resend()}
          onClose={() => {
            setResending(false);
            setResendError(null);
          }}
        >
          <p>
            A new temporary password is emailed to <span className="[overflow-wrap:anywhere]">{professor.account?.email}</span>. The previous one stops working
            immediately. You will not see the password.
          </p>
        </ConfirmDialog>
        <form noValidate onSubmit={save} className="max-w-3xl">
          <Panel className="flex flex-col gap-4 px-5 py-5">
            <ErrorSummary
              errors={errors.fields}
              formError={errors.form}
              labels={{ name: "Name", email: "Login email", department: "Department", designation: "Designation" }}
              fieldIds={{ name: "p-name", email: "p-email", department: "p-department", designation: "p-designation" }}
              summaryRef={errors.summaryRef}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="p-name" label="Name" required error={errors.fields.name}>
                {(p) => <input {...p} className="input" value={form.name} onChange={set("name")} maxLength={200} />}
              </Field>
              {professor.account && (
                <Field
                  id="p-email"
                  label="Login email"
                  hint={
                    professor.account.activated
                      ? "Changing it cancels a pending recovery code."
                      : "Not activated yet: changing it emails a new temporary password to the new address."
                  }
                  error={errors.fields.email}
                >
                  {(p) => <input {...p} className="input" type="email" autoComplete="off" value={form.email} onChange={set("email")} />}
                </Field>
              )}
              <Field id="p-department" label="Department" error={errors.fields.department}>
                {(p) => <input {...p} className="input" value={form.department} onChange={set("department")} maxLength={200} />}
              </Field>
              <Field id="p-designation" label="Designation" error={errors.fields.designation}>
                {(p) => <input {...p} className="input" value={form.designation} onChange={set("designation")} maxLength={200} />}
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…" disabled={!changed}>
                Save profile
              </Button>
            </div>
          </Panel>
        </form>
        {!professor.account && (
          <form noValidate onSubmit={createAccount} className="max-w-3xl">
            <Panel className="flex flex-col gap-4 px-5 py-5">
              <div>
                <h3 className="text-[15px] font-semibold">No login account</h3>
                <p className="text-[13px] text-text-muted">
                  Create one so the professor can verify publications. A temporary password is emailed to them; you never see it.
                </p>
              </div>
              <ErrorSummary
                errors={accountErrors.fields}
                formError={accountErrors.form}
                labels={{ email: "Login email" }}
                fieldIds={{ email: "acc-email" }}
                summaryRef={accountErrors.summaryRef}
              />
              <Field id="acc-email" label="Login email" required error={accountErrors.fields.email}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    type="email"
                    autoComplete="off"
                    value={newAccountEmail}
                    onChange={(e) => setNewAccountEmail(e.target.value)}
                  />
                )}
              </Field>
              <div>
                <Button type="submit" loading={accountBusy} loadingLabel="Creating…">
                  Create account
                </Button>
              </div>
            </Panel>
          </form>
        )}
      </div>
    </section>
  );
}

function StatusSection({ professor, onSaved }: { professor: ProfessorDetail; onSaved: (p: ProfessorDetail) => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      const { professor: saved } = await api<{ professor: ProfessorDetail }>(`/admin/professors/${professor.id}/status`, {
        method: "PATCH",
        body: { isActive: !professor.isActive },
      });
      onSaved(saved);
      setConfirming(false);
      toast(saved.isActive ? `${saved.name} was reactivated.` : `${saved.name} was deactivated.`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="status-heading" className="max-w-3xl">
      <SectionTitle id="status-heading">Activation</SectionTitle>
      <Panel className="flex flex-col items-start gap-3 px-5 py-5">
        <p className="text-[15px]">
          {professor.isActive
            ? "Active: the professor can sign in and their active identities are synchronized."
            : "Inactive: the professor cannot sign in and is not synchronized. All publications and decisions are kept."}
        </p>
        <Button variant={professor.isActive ? "danger" : "primary"} icon={<Power aria-hidden size={18} />} onClick={() => setConfirming(true)}>
          {professor.isActive ? "Deactivate professor" : "Reactivate professor"}
        </Button>
      </Panel>
      <ConfirmDialog
        open={confirming}
        title={professor.isActive ? `Deactivate ${professor.name}?` : `Reactivate ${professor.name}?`}
        confirmLabel={professor.isActive ? "Deactivate" : "Reactivate"}
        busyLabel="Saving…"
        danger={professor.isActive}
        busy={busy}
        error={err}
        onConfirm={() => void apply()}
        onClose={() => {
          setConfirming(false);
          setErr(null);
        }}
      >
        <p>
          {professor.isActive
            ? "They will no longer be able to sign in, and their identities will not be synchronized. Their publications and decisions are kept."
            : "They can sign in again, and their active identities are synchronized again."}
        </p>
      </ConfirmDialog>
    </section>
  );
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

function IdentitiesSection({ professor, onChanged }: { professor: ProfessorDetail; onChanged: () => void }) {
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
    const path = `/admin/professors/${professor.id}/identities/${identity.id}`;
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
        External identities
      </SectionTitle>
      <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
        Synchronization collects publications through these identities. A professor may have several per source. An identity is saved after it is checked
        with its source, or — for Scopus and Web of Science without API access — after an administrator verifies it from the author’s public profile. Synchronization checks each
        identity with its source again before accepting publications.
      </p>
      <div className="flex flex-col gap-4">
        {adding && (
          <AddIdentity
            professorId={professor.id}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              toast("Identity saved.");
              onChanged();
            }}
          />
        )}
        <Panel>
          {professor.identities.length === 0 ? (
            <EmptyState>No identities yet. Add an OpenAlex, DBLP, ORCID, Scopus or Web of Science identity so this professor’s publications can be collected.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">External identities</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Identifier</th>
                    <th scope="col">Verified</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {professor.identities.map((identity) => (
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
                      <td data-label="Status">
                        <StatusChip status={identity.isActive ? "ACTIVE" : "INACTIVE"} />
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

function AddIdentity({ professorId, onCancel, onSaved }: { professorId: string; onCancel: () => void; onSaved: () => void }) {
  const [source, setSource] = useState<IdentitySource>("OPENALEX");
  const [externalId, setExternalId] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | "manual" | null>(null);
  const errors = useFormErrors();

  const evidence = PROFILE_EVIDENCE[source];

  /** Scopus or Web of Science without API credentials: the administrator verifies from the public profile (decision #118). */
  async function saveManually() {
    if (!evidence) return;
    const local: Record<string, string> = {};
    if (!externalId.trim()) local.externalId = `Enter the ${evidence.idLabel}`;
    if (!evidenceUrl.trim()) local.evidenceUrl = `Enter the author’s ${evidence.urlLabel}`;
    if (Object.keys(local).length > 0) return errors.setLocal(local);
    errors.clear();
    setBusy("manual");
    try {
      await api(`/admin/professors/${professorId}/identities/manual`, { method: "POST", body: { source, externalId, evidenceUrl } });
      onSaved();
    } catch (error) {
      errors.fromError(error, { INVALID_IDENTIFIER: "externalId", INVALID_EVIDENCE: "evidenceUrl", EVIDENCE_MISMATCH: "evidenceUrl" });
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
      setPreview(await api<IdentityPreview>(`/admin/professors/${professorId}/identities/preview`, { method: "POST", body: { source, externalId } }));
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
      await api(`/admin/professors/${professorId}/identities`, { method: "POST", body: { previewToken: preview.previewToken } });
      onSaved();
    } catch (error) {
      errors.fromError(error);
      setBusy(null);
    }
  }

  const p = preview?.preview;
  const assigned = preview?.alreadyAssigned;
  return (
    <Panel className="max-w-3xl px-5 py-5">
      <form noValidate onSubmit={runPreview} className="flex flex-col gap-4">
        <h3 className="text-[15px] font-semibold">Add identity</h3>
        <ErrorSummary
          errors={errors.fields}
          formError={errors.form}
          labels={{ externalId: "Identifier", source: "Source", evidenceUrl: evidence?.urlLabel ?? "Profile URL" }}
          fieldIds={{ externalId: "id-value", source: "id-source", evidenceUrl: "id-evidence" }}
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
                ? "Needed to save without the Web of Science API: open the author’s Web of Science record, confirm it is this professor, and paste its URL (it must contain the ResearcherID). Each synchronization accepts only documents that list this ResearcherID among their authors."
                : "Needed to save without the Scopus API: open the author’s Scopus profile, confirm it is this professor, and paste its URL. The next synchronization checks the Author ID with Scopus before accepting any publication."
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
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy === "preview"} loadingLabel="Checking with the source…" disabled={busy === "save" || busy === "manual"}>
            Check identity
          </Button>
          {evidence && (
            <Button onClick={() => void saveManually()} loading={busy === "manual"} loadingLabel="Saving…" disabled={busy === "preview" || busy === "save"}>
              Save as verified from profile
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
            <Alert tone={assigned.sameProfessor ? "info" : "danger"}>
              {assigned.sameProfessor
                ? "This identity is already saved for this professor."
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
