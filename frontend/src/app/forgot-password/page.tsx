"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorSummary, Field, PasswordInput, useFormErrors } from "@/components/form";
import { Alert, Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

/**
 * Professor password recovery (Project_plan.md §15.4, pages/login.md): email → 6-digit code →
 * new password. The reset token lives only in the HttpOnly cookie the backend sets on verify.
 */

const RESEND_SECONDS = 60;

function friendly(error: unknown): ApiError | unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "RECOVERY_UNAVAILABLE") return new ApiError(503, error.code, "Password recovery is not available right now. Contact the administrator.");
  if (error.code === "RATE_LIMITED") return new ApiError(429, error.code, "Too many attempts. Try again in a few minutes.");
  return error;
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const errors = useFormErrors();

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function requestCode() {
    if (!email.trim()) return errors.setLocal({ email: "Enter your email address" });
    errors.clear();
    setBusy(true);
    try {
      const { message } = await api<{ message: string }>("/auth/password-recovery/request", { method: "POST", body: { email }, ignoreAuthErrors: true });
      setSentNotice(message);
      setResendIn(RESEND_SECONDS);
      setStep(2);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VALIDATION_ERROR") errors.setLocal({ email: "Enter a valid email address" });
      else errors.fromError(friendly(error));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return errors.setLocal({ code: "Enter the 6-digit code from the email" });
    errors.clear();
    setBusy(true);
    try {
      await api("/auth/password-recovery/verify", { method: "POST", body: { email, code }, ignoreAuthErrors: true });
      setStep(3);
    } catch (error) {
      errors.fromError(friendly(error), { INVALID_OR_EXPIRED_CODE: "code" });
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!password) local.password = "Enter a new password";
    else if (password !== confirm) local.confirm = "The passwords do not match";
    if (Object.keys(local).length) return errors.setLocal(local);
    errors.clear();
    setBusy(true);
    try {
      await api("/auth/password-recovery/reset", { method: "POST", body: { newPassword: password }, ignoreAuthErrors: true });
      router.replace("/login?notice=password-reset");
    } catch (error) {
      errors.fromError(friendly(error), { INVALID_PASSWORD: "password", PASSWORD_REUSED: "password" });
      setBusy(false);
    }
  }

  const summary = (
    <ErrorSummary
      errors={errors.fields}
      formError={errors.form}
      labels={{ email: "Email", code: "Code", password: "New password", confirm: "Confirm new password" }}
      fieldIds={{ email: "email", code: "code", password: "new-password", confirm: "confirm-password" }}
      summaryRef={errors.summaryRef}
    />
  );
  const back = (
    <Link href="/login" className="text-[15px] text-ink hover:underline underline-offset-4">
      Back to sign in
    </Link>
  );

  if (step === 1) {
    return (
      <AuthLayout step="Step 1 of 3" title="Reset your password" description="For professor accounts. We send a 6-digit code to your account email.">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void requestCode();
          }}
          className="flex flex-col gap-4"
        >
          {summary}
          <Field id="email" label="Email" error={errors.fields.email}>
            {(p) => <input {...p} className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Sending…" className="w-full">
            Send code
          </Button>
          {back}
        </form>
      </AuthLayout>
    );
  }

  if (step === 2) {
    return (
      <AuthLayout step="Step 2 of 3" title="Enter the code" description={`The code is valid for 10 minutes.`}>
        <form noValidate onSubmit={verify} className="flex flex-col gap-4">
          {sentNotice && (
            <Alert tone="info" role="status">
              {sentNotice}
            </Alert>
          )}
          {summary}
          <Field id="code" label="6-digit code" error={errors.fields.code}>
            {(p) => (
              <input
                {...p}
                className="input font-mono tracking-[0.3em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Checking…" className="w-full">
            Continue
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="quiet" compact disabled={resendIn > 0 || busy} onClick={() => void requestCode()}>
              Send a new code
            </Button>
            {resendIn > 0 && <span className="text-[13px] text-text-muted tabular-nums">Available in {resendIn} s</span>}
          </div>
          {back}
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout step="Step 3 of 3" title="Choose a new password">
      <form noValidate onSubmit={reset} className="flex flex-col gap-4">
        {summary}
        <Field id="new-password" label="New password" error={errors.fields.password} hint="10 to 72 characters, different from your current password.">
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field id="confirm-password" label="Confirm new password" error={errors.fields.confirm}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving…" className="w-full">
          Set new password
        </Button>
        {back}
      </form>
    </AuthLayout>
  );
}
