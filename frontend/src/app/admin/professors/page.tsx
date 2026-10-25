"use client";

import Link from "next/link";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { Dialog } from "@/components/dialog";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { InvitationNotice } from "@/components/invitation-status";
import { Button, ButtonLink, EmptyState, LoadError, PageHeader, Panel, SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { AccountResult, ProfessorRow } from "@/lib/types";

/** Professor list and creation (Project_plan.md §15.1, Phase 9). */
export default function ProfessorsPage() {
  const { data, error, reload } = useResource<ProfessorRow[]>("/admin/professors", (signal) =>
    api<{ professors: ProfessorRow[] }>("/admin/professors", { signal }).then((r) => r.professors),
  );
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Professors"
        description="Professors are deactivated, never deleted. Each one signs in with their own account; their external identities drive synchronization."
        actions={
          <Button variant="primary" icon={<UserPlus aria-hidden size={18} />} onClick={() => setCreating(true)}>
            Add professor
          </Button>
        }
      />
      <Panel>
        {error && !data ? (
          <div className="p-4">
            <LoadError error={error} onRetry={() => void reload()} />
          </div>
        ) : !data ? (
          <SkeletonRows rows={4} label="Loading professors" />
        ) : data.length === 0 ? (
          <EmptyState action={<Button onClick={() => setCreating(true)}>Add the first professor</Button>}>No professors yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">Professors, {data.length} in total</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="num">
                    Identities
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td className="no-label">
                      <Link href={`/admin/professors/${p.id}`} className="font-medium text-ink hover:underline underline-offset-4">
                        {p.name}
                      </Link>
                      <p className="text-[13px] leading-5 text-text-muted">{[p.designation, p.department].filter(Boolean).join(" · ") || "–"}</p>
                    </td>
                    <td data-label="Account" className="text-[13px]">
                      {p.account ? (
                        <>
                          <span className="[overflow-wrap:anywhere]">{p.account.email}</span>
                          {!p.account.activated && <p className="text-text-muted">Not activated yet</p>}
                        </>
                      ) : (
                        <span className="text-text-muted">No account</span>
                      )}
                    </td>
                    <td data-label="Identities" className="num">
                      {formatNumber(p.identityCount)}
                    </td>
                    <td data-label="Status">
                      <StatusChip status={p.isActive ? "ACTIVE" : "INACTIVE"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <CreateProfessorDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void reload()} />
    </>
  );
}

function CreateProfessorDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const empty = { name: "", department: "", designation: "", email: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AccountResult | null>(null);
  const errors = useFormErrors();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function close() {
    setForm(empty);
    setCreated(null);
    errors.clear();
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = "Enter the professor's name";
    if (!form.email.trim()) local.email = "Enter the login email";
    if (Object.keys(local).length) return errors.setLocal(local);
    errors.clear();
    setBusy(true);
    try {
      const result = await api<AccountResult>("/admin/professors", {
        method: "POST",
        body: { name: form.name, email: form.email, department: form.department || null, designation: form.designation || null },
      });
      setCreated(result);
      onCreated();
    } catch (error) {
      errors.fromError(error, { EMAIL_IN_USE: "email" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={created ? "Professor added" : "Add professor"} onClose={close} busy={busy}>
      {created ? (
        <div className="flex flex-col gap-4">
          <p>
            <strong className="font-medium">{created.professor.name}</strong> was added with a login account.
          </p>
          {created.invitation && <InvitationNotice status={created.invitation.status} email={created.professor.account?.email ?? form.email} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={close}>Close</Button>
            <ButtonLink href={`/admin/professors/${created.professor.id}`} variant="primary">
              Add identities
            </ButtonLink>
          </div>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <ErrorSummary
            errors={errors.fields}
            formError={errors.form}
            labels={{ name: "Name", email: "Login email", department: "Department", designation: "Designation" }}
            fieldIds={{ name: "new-name", email: "new-email", department: "new-department", designation: "new-designation" }}
            summaryRef={errors.summaryRef}
          />
          <Field id="new-name" label="Name" required error={errors.fields.name}>
            {(p) => <input {...p} className="input" value={form.name} onChange={set("name")} maxLength={200} />}
          </Field>
          <Field
            id="new-email"
            label="Login email"
            required
            hint="A temporary password is emailed to this address; you never see it."
            error={errors.fields.email}
          >
            {(p) => <input {...p} className="input" type="email" autoComplete="off" value={form.email} onChange={set("email")} />}
          </Field>
          <Field id="new-department" label="Department" error={errors.fields.department}>
            {(p) => <input {...p} className="input" value={form.department} onChange={set("department")} maxLength={200} />}
          </Field>
          <Field id="new-designation" label="Designation" error={errors.fields.designation}>
            {(p) => <input {...p} className="input" value={form.designation} onChange={set("designation")} maxLength={200} />}
          </Field>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} loadingLabel="Adding…">
              Add professor
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
