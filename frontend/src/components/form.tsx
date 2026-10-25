"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { ApiError } from "@/lib/api";

/** Form primitives (design system §6.4): visible labels, helper text, errors linked to fields. */

export function Field({
  label,
  required,
  hint,
  error,
  children,
  id,
}: {
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string;
  /** Receives the ids to wire: the control's id and its aria-describedby. */
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; required?: boolean }) => React.ReactNode;
  id?: string;
}) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={controlId} className="text-[13px] leading-[18px] font-medium">
        {label}
        {required && <span className="font-normal text-text-muted"> (required)</span>}
      </label>
      {children({ id: controlId, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-[13px] leading-5 text-danger">
          <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-[13px] leading-5 text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? "text" : "password"} className="input pr-12" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-r-md text-text-muted hover:text-text"
      >
        {visible ? <EyeOff aria-hidden size={18} /> : <Eye aria-hidden size={18} />}
      </button>
    </div>
  );
}

export type FieldErrors = Record<string, string>;

/**
 * Form-level error state. Field errors come from the API's `details[].path` or from known
 * error codes; anything else becomes a form-level message. After a failed submit with field
 * errors, the summary receives focus (§6.4).
 */
export function useFormErrors() {
  const [fields, setFields] = useState<FieldErrors>({});
  const [form, setForm] = useState<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const [focusSummary, setFocusSummary] = useState(0);

  useEffect(() => {
    if (focusSummary) summary.current?.focus();
  }, [focusSummary]);

  const clear = useCallback(() => {
    setFields({});
    setForm(null);
  }, []);

  /** codeToField maps API error codes to a field name (e.g. INVALID_DOI → doi). */
  const fromError = useCallback((error: unknown, codeToField: Record<string, string> = {}) => {
    if (error instanceof ApiError) {
      const issues = error.fieldIssues;
      if (issues.length > 0) {
        const next: FieldErrors = {};
        for (const issue of issues) if (!next[issue.path || "_"]) next[issue.path || "_"] = issue.message;
        const { _: general, ...rest } = next;
        setFields(rest);
        setForm(general ?? (Object.keys(rest).length ? null : error.message));
        setFocusSummary((n) => n + 1);
        return;
      }
      const field = codeToField[error.code];
      if (field) {
        setFields({ [field]: error.message });
        setForm(null);
        setFocusSummary((n) => n + 1);
        return;
      }
      setFields({});
      setForm(error.message);
      setFocusSummary((n) => n + 1);
      return;
    }
    setFields({});
    setForm("Something went wrong. Try again.");
    setFocusSummary((n) => n + 1);
  }, []);

  const setLocal = useCallback((errors: FieldErrors) => {
    setFields(errors);
    setForm(null);
    if (Object.keys(errors).length) setFocusSummary((n) => n + 1);
  }, []);

  return { fields, form, clear, fromError, setLocal, summaryRef: summary };
}

/** Focusable error summary with links to the fields (role="alert"). */
export function ErrorSummary({
  errors,
  formError,
  labels,
  fieldIds,
  summaryRef,
}: {
  errors: FieldErrors;
  formError: string | null;
  labels: Record<string, string>;
  fieldIds: Record<string, string>;
  summaryRef: React.RefObject<HTMLDivElement | null>;
}) {
  const entries = Object.entries(errors);
  if (!formError && entries.length === 0) return null;
  return (
    <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-md bg-danger-bg px-4 py-3 text-text outline-none focus-visible:outline-2">
      <p className="flex items-center gap-2 font-semibold text-danger">
        <CircleAlert aria-hidden size={18} className="shrink-0" />
        There is a problem
      </p>
      {entries.length === 0 && <p className="mt-1 pl-[26px] text-[15px]">{formError}</p>}
      {entries.length > 0 && (
        <ul className="mt-1 list-disc pl-9 text-[15px]">
          {formError && <li>{formError}</li>}
          {entries.map(([key, message]) => (
            <li key={key}>
              <a href={`#${fieldIds[key] ?? key}`} className="underline underline-offset-4">
                {labels[key] ? `${labels[key]}: ` : ""}
                {message}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
