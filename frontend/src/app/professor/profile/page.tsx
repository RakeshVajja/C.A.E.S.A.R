"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { ErrorSummary, Field, useFormErrors } from "@/components/form";
import { useToast } from "@/components/toast";
import { Button, LoadError, PageHeader, Panel, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/use-resource";
import type { OwnProfile } from "@/lib/types";

/** The professor's own profile: only the name is editable (decision #67), behind an explicit Edit. */
export default function ProfilePage() {
  const { refresh } = useAuth();
  const toast = useToast();
  const { data, error, reload, setData } = useResource<OwnProfile>("/me/profile", (signal) =>
    api<{ profile: OwnProfile }>("/me/profile", { signal }).then((r) => r.profile),
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFormErrors();
  const editRef = useRef<HTMLButtonElement>(null);

  function startEditing() {
    if (!data) return;
    setName(data.name);
    errors.clear();
    setEditing(true);
  }

  function stopEditing() {
    setEditing(false);
    errors.clear();
    requestAnimationFrame(() => editRef.current?.focus());
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return errors.setLocal({ name: "Enter your name" });
    errors.clear();
    setBusy(true);
    try {
      const { profile } = await api<{ profile: OwnProfile }>("/me/profile", { method: "PATCH", body: { name } });
      setData(profile);
      void refresh(); // the account block shows the name
      toast("Your name was saved.");
      stopEditing();
    } catch (error) {
      errors.fromError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Profile" description="Your department, designation and login email are managed by the administrator. Contact them to change these." />
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <div role="status" aria-label="Loading profile" className="flex max-w-xl flex-col gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="flex max-w-xl flex-col gap-5">
          {editing && (
            <ErrorSummary errors={errors.fields} formError={errors.form} labels={{ name: "Name" }} fieldIds={{ name: "name" }} summaryRef={errors.summaryRef} />
          )}
          <Panel className="flex flex-col gap-4 px-5 py-5">
            {editing ? (
              <form noValidate onSubmit={save} className="flex flex-col gap-3">
                <Field id="name" label="Name" required error={errors.fields.name}>
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      autoComplete="name"
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && !busy) stopEditing();
                      }}
                      maxLength={200}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…" disabled={name.trim() === data.name}>
                    Save name
                  </Button>
                  <Button onClick={stopEditing} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-text-muted">Name</div>
                  <div className="[overflow-wrap:anywhere]">{data.name}</div>
                </div>
                {/* Icon-only control: 44px hit area, offset so the glyph aligns with the panel's content edge. */}
                <button
                  ref={editRef}
                  type="button"
                  onClick={startEditing}
                  aria-label="Edit name"
                  title="Edit name"
                  className="-mt-2.5 -mr-3 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-surface-sunken hover:text-text active:bg-surface-sunken"
                >
                  <Pencil aria-hidden size={18} />
                </button>
              </div>
            )}
            <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <div>
                <dt className="text-[13px] font-medium text-text-muted">Department</dt>
                <dd>{data.department ?? "–"}</dd>
              </div>
              <div>
                <dt className="text-[13px] font-medium text-text-muted">Designation</dt>
                <dd>{data.designation ?? "–"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[13px] font-medium text-text-muted">Login email</dt>
                <dd className="[overflow-wrap:anywhere]">{data.email}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      )}
    </>
  );
}
