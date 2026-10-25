"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorSummary, Field, PasswordInput, useFormErrors } from "@/components/form";
import { Alert, Button, Skeleton } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";

/**
 * Change password — forced after a temporary password (only this screen is available until done,
 * matching PASSWORD_CHANGE_REQUIRED) or voluntary from the account menu.
 */
export default function ChangePasswordPage() {
  const { status, user, setUser, signOut } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFormErrors();

  useEffect(() => {
    if (status === "signedOut") router.replace("/login?next=/change-password");
  }, [status, router]);

  if (status !== "signedIn" || !user) {
    return (
      <AuthLayout title="Change password">
        <div role="status" aria-label="Checking your session" className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </AuthLayout>
    );
  }
  const forced = user.mustChangePassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!current) local.current = "Enter your current password";
    if (!password) local.password = "Enter a new password";
    else if (password !== confirm) local.confirm = "The passwords do not match";
    if (Object.keys(local).length) return errors.setLocal(local);
    errors.clear();
    setBusy(true);
    try {
      const { user: updated } = await api<{ user: User }>("/auth/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: password },
      });
      setUser(updated);
      toast("Your password was changed.");
      router.replace(homeFor(updated.role));
    } catch (error) {
      errors.fromError(error, { INVALID_CURRENT_PASSWORD: "current", INVALID_PASSWORD: "password", PASSWORD_REUSED: "password" });
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={forced ? "Set a new password" : "Change password"}
      description={forced ? "You signed in with the temporary password from your sign-in email. Choose your own password to continue." : undefined}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {forced && (
          <Alert tone="info">
            Signed in as <strong className="font-medium">{user.email}</strong>.
          </Alert>
        )}
        <ErrorSummary
          errors={errors.fields}
          formError={errors.form}
          labels={{ current: "Current password", password: "New password", confirm: "Confirm new password" }}
          fieldIds={{ current: "current-password", password: "new-password", confirm: "confirm-password" }}
          summaryRef={errors.summaryRef}
        />
        <Field id="current-password" label={forced ? "Temporary password" : "Current password"} error={errors.fields.current}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field
          id="new-password"
          label="New password"
          error={errors.fields.password}
          hint="10 to 72 characters, different from the current password. Other sessions are signed out."
        >
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field id="confirm-password" label="Confirm new password" error={errors.fields.confirm}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…" className="w-full">
          {forced ? "Set password and continue" : "Change password"}
        </Button>
        {forced ? (
          <Button
            variant="quiet"
            className="self-start"
            onClick={async () => {
              await signOut();
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        ) : (
          <Link href={homeFor(user.role)} className="text-[15px] text-ink hover:underline underline-offset-4">
            Cancel
          </Link>
        )}
      </form>
    </AuthLayout>
  );
}
