"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorSummary, Field, PasswordInput, useFormErrors } from "@/components/form";
import { Alert, Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";

/** Only same-site paths are accepted as a return address. */
function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

function LoginForm() {
  const { status, user, setUser } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const notice = params.get("notice");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFormErrors();

  // Already signed in: go to the right place.
  useEffect(() => {
    if (status === "signedIn" && user) {
      // A return address is used only when it belongs to this account's area (e.g. after a sign-out by another role).
      const home = homeFor(user.role);
      const target = next && (next === home || next.startsWith(`${home}/`)) ? next : home;
      router.replace(user.mustChangePassword ? "/change-password" : target);
    }
  }, [status, user, next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!email.trim()) local.email = "Enter your email address";
    if (!password) local.password = "Enter your password";
    if (Object.keys(local).length) return errors.setLocal(local);
    errors.clear();
    setBusy(true);
    try {
      const { user: signedIn } = await api<{ user: User }>("/auth/login", { method: "POST", body: { email, password }, ignoreAuthErrors: true });
      setUser(signedIn);
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
        errors.fromError(new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect."));
      } else if (error instanceof ApiError && error.code === "RATE_LIMITED") {
        errors.fromError(new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again in a few minutes."));
      } else if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
        errors.setLocal({ email: "Enter a valid email address" });
      } else {
        errors.fromError(error);
      }
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {notice === "password-reset" && (
          <Alert tone="success" role="status">
            Your password was updated. Sign in with your new password.
          </Alert>
        )}
        <ErrorSummary
          errors={errors.fields}
          formError={errors.form}
          labels={{ email: "Email", password: "Password" }}
          fieldIds={{ email: "email", password: "password" }}
          summaryRef={errors.summaryRef}
        />
        <Field id="email" label="Email" error={errors.fields.email}>
          {(p) => <input {...p} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field id="password" label="Password" error={errors.fields.password}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} loadingLabel="Signing in…" className="mt-2 w-full">
          Sign in
        </Button>
        <div className="flex flex-col gap-1 text-[13px] leading-5 text-text-muted">
          <Link href="/forgot-password" className="self-start text-[15px] text-ink hover:underline underline-offset-4">
            Forgot password?
          </Link>
          <p>For professors. Administrators reset their password with the server command line.</p>
        </div>
      </form>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
