"use client";

import Link from "next/link";
import { forwardRef, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ExternalLink, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { doiUrl, rangeLabel } from "@/lib/format";
import { errorMessage } from "@/lib/api";

/* ── Buttons (design system §6.3) ─────────────────────────────────────── */

type Variant = "primary" | "secondary" | "quiet" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "bg-ink text-on-ink hover:bg-ink-hover border border-transparent",
  secondary: "bg-surface text-text border border-border-strong hover:bg-surface-sunken",
  quiet: "bg-transparent text-ink border border-transparent hover:underline underline-offset-4",
  danger: "bg-danger text-on-danger border border-transparent hover:opacity-90",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  compact?: boolean;
  loading?: boolean;
  /** Label shown while loading ("Saving…"). */
  loadingLabel?: string;
  icon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", compact, loading, loadingLabel, icon, className = "", children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        compact ? "min-h-9 px-3 text-sm" : "min-h-10 px-4 text-[15px]"
      } ${variant === "quiet" ? "px-2" : ""} ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden size={16} className="animate-spin" /> : icon}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "secondary",
  compact,
  icon,
  children,
  className = "",
}: {
  href: string;
  variant?: Variant;
  compact?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 ${
        compact ? "min-h-9 px-3 text-sm" : "min-h-10 px-4 text-[15px]"
      } ${VARIANT[variant]} ${className}`}
    >
      {icon}
      {children}
    </Link>
  );
}

/* ── Page header (§5) ─────────────────────────────────────────────────── */

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { href: string; label: string }[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Focus moves to the page title after navigation (§5, §8).
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2 text-[13px] text-text-muted">
            <ol className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((b) => (
                <li key={b.href} className="flex items-center gap-1">
                  <Link href={b.href} className="text-ink hover:underline underline-offset-4">
                    {b.label}
                  </Link>
                  <ChevronRight aria-hidden size={14} />
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 ref={heading} tabIndex={-1} className="text-[28px] leading-9 font-semibold outline-none">
          {title}
        </h1>
        {description && <p className="mt-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionTitle({ children, id, actions }: { children: React.ReactNode; id?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <h2 id={id} className="text-xl leading-7 font-semibold">
        {children}
      </h2>
      {actions}
    </div>
  );
}

export function Panel({ children, className = "", labelledBy }: { children: React.ReactNode; className?: string; labelledBy?: string }) {
  return (
    <section aria-labelledby={labelledBy} className={`rounded-lg border border-border bg-surface ${className}`}>
      {children}
    </section>
  );
}

/* ── Alerts (§6.5) ────────────────────────────────────────────────────── */

type Tone = "info" | "success" | "warning" | "danger";
const TONE: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: { box: "bg-info-bg text-info", Icon: Info },
  success: { box: "bg-success-bg text-success", Icon: CircleCheck },
  warning: { box: "bg-warning-bg text-warning", Icon: TriangleAlert },
  danger: { box: "bg-danger-bg text-danger", Icon: CircleAlert },
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  role?: "alert" | "status";
}) {
  const { box, Icon } = TONE[tone];
  return (
    <div role={role} className={`flex gap-3 rounded-md px-4 py-3 ${box}`}>
      <Icon aria-hidden size={20} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-text">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-[15px]">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

/** A failed load: the API message and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert
      tone="danger"
      role="alert"
      title="This could not be loaded"
      action={
        onRetry && (
          <Button compact onClick={onRetry}>
            Try again
          </Button>
        )
      }
    >
      {errorMessage(error)}
    </Alert>
  );
}

/* ── Loading and empty states ─────────────────────────────────────────── */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-surface-sunken ${className}`} />;
}

export function SkeletonRows({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-[72px] flex-col justify-center gap-2 px-4 py-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-8 text-text-muted">
      <p className="max-w-[72ch]">{children}</p>
      {action}
    </div>
  );
}

/* ── Data bits (§9) ───────────────────────────────────────────────────── */

export function Missing() {
  return <span aria-label="not available">–</span>;
}

export function Doi({ doi }: { doi: string | null }) {
  if (!doi) return <Missing />;
  return (
    <a
      href={doiUrl(doi)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-[13px] text-ink [overflow-wrap:anywhere] hover:underline underline-offset-4"
    >
      {doi}
      <ExternalLink aria-hidden size={14} className="shrink-0" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

export function ExternalProfileLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink hover:underline underline-offset-4">
      {children}
      <ExternalLink aria-hidden size={14} />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

/**
 * Overview figures as separate, non-interactive blocks (§6.6; owner request). Spacing follows the
 * UI/UX Pro Max guidance: one grid gap (12px on phones, 16px from 768px), uniform padding inside
 * each block, no hover effect. Two per row on phones, then as many equal columns as fit.
 */
export function Figures({ items }: { items: { label: string; value: React.ReactNode; note?: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] md:gap-4">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={`flex flex-col rounded-lg border border-border bg-surface p-4 md:p-5 ${i === items.length - 1 && i % 2 === 0 ? "max-md:col-span-2" : ""}`}
        >
          <dt className="text-[13px] leading-[18px] font-medium text-text-muted">{item.label}</dt>
          <dd className="mt-2 text-[28px] leading-8 font-semibold tabular-nums">{item.value}</dd>
          {item.note && <dd className="mt-1 text-[13px] leading-5 text-text-muted">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/* ── Segmented control (filters in the URL) ───────────────────────────── */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md border border-border-strong bg-surface p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`min-h-9 cursor-pointer rounded-[5px] px-3 text-sm font-medium transition-colors duration-150 ${
              active ? "bg-ink text-on-ink" : "text-text hover:bg-surface-sunken"
            }`}
          >
            {o.label}
            {o.count !== undefined && <span className={`ml-1.5 tabular-nums ${active ? "" : "text-text-muted"}`}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── Pagination ───────────────────────────────────────────────────────── */

export function Pagination({
  offset,
  limit,
  count,
  total,
  onPage,
}: {
  offset: number;
  limit: number;
  count: number;
  total: number;
  onPage: (offset: number) => void;
}) {
  if (total <= limit && offset === 0) return total > 0 ? <p className="px-4 py-3 text-[13px] text-text-muted">{rangeLabel(offset, count, total)}</p> : null;
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
      <p className="text-[13px] text-text-muted tabular-nums">{rangeLabel(offset, count, total)}</p>
      <div className="flex gap-2">
        <Button compact icon={<ChevronLeft aria-hidden size={16} />} disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <Button compact disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>
          Next
          <ChevronRight aria-hidden size={16} />
        </Button>
      </div>
    </nav>
  );
}
