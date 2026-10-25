/** Centred single-column layout for sign-in and recovery (pages/login.md). */
export function AuthLayout({ title, description, children, step }: { title: string; description?: React.ReactNode; children: React.ReactNode; step?: string }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center px-4 py-12 md:py-20">
      <div className="w-full max-w-[400px]">
        <div className="mb-8">
          <p className="text-2xl leading-8 font-semibold">CSE Research Hub</p>
          <p className="mt-3 text-[13px] leading-5 text-text-muted">Department of Computer Science and Engineering, IIT (ISM) Dhanbad</p>
        </div>
        <section aria-labelledby="auth-title" className="rounded-lg border border-border bg-surface px-5 py-6 md:px-6">
          {step && <p className="mb-1 text-[13px] font-medium text-text-muted">{step}</p>}
          <h1 id="auth-title" className="text-[22px] leading-8 font-semibold">
            {title}
          </h1>
          {description && <div className="mt-2 text-[15px] text-text-muted">{description}</div>}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}
