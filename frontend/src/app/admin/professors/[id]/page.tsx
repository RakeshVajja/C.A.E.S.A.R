"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Mail, Power, Trash2 } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { IdentitiesSection } from "@/components/identities";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { InvitationNotice } from "@/components/invitation-status";
import { useToast } from "@/components/toast";
import { Button, LoadError, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { AccountResult, InvitationStatus, ProfessorDetail } from "@/lib/types";

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
        <IdentitiesSection identities={data.identities} basePath={`/admin/professors/${data.id}/identities`} audience="ADMIN" onChanged={() => void reload()} />
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

/**
 * Permanent deletion of an inactive professor's record (decision #170): the account, identities,
 * every publication link, and the publications no other professor is linked to. Irreversible; the
 * administrator types the professor's name, and the server checks it again.
 */
function DeleteProfessor({ professor }: { professor: ProfessorDetail }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const matches = typed.trim() === professor.name.trim();

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const { deleted } = await api<{ deleted: { publications: number; relationships: number } }>(`/admin/professors/${professor.id}`, {
        method: "DELETE",
        body: { confirmName: typed },
      });
      toast(`${professor.name} was deleted with ${formatNumber(deleted.relationships)} publication links; ${formatNumber(deleted.publications)} publications only they were linked to were deleted.`);
      router.push("/admin/professors");
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="danger" icon={<Trash2 aria-hidden size={18} />} onClick={() => setOpen(true)}>
        Delete professor
      </Button>
      <ConfirmDialog
        open={open}
        title={`Delete ${professor.name} permanently?`}
        confirmLabel="Delete permanently"
        busyLabel="Deleting…"
        danger
        busy={busy}
        error={err}
        confirmDisabled={!matches}
        onConfirm={() => void remove()}
        onClose={() => {
          if (busy) return;
          setOpen(false);
          setTyped("");
          setErr(null);
        }}
      >
        <p>This cannot be undone. It deletes, from the database:</p>
        <ul className="list-disc pl-5 text-[15px]">
          <li>the professor&apos;s record, login account and external identities;</li>
          <li>all their publication links — approved, pending and rejected;</li>
          <li>every publication no other professor is linked to, with its source records and citation data.</li>
        </ul>
        <p>Publications shared with other professors are kept, with those professors&apos; decisions.</p>
        <Field label={`Type “${professor.name}” to confirm`}>
          {(p) => <input {...p} className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </ConfirmDialog>
    </>
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
        <div className="flex flex-wrap gap-3">
          <Button variant={professor.isActive ? "danger" : "primary"} icon={<Power aria-hidden size={18} />} onClick={() => setConfirming(true)}>
            {professor.isActive ? "Deactivate professor" : "Reactivate professor"}
          </Button>
          {!professor.isActive && <DeleteProfessor professor={professor} />}
        </div>
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
