import Link from "next/link";
import { PageHeader } from "./ui";

/** Guidance page layout shared by the professor and administrator help pages (More menu → Help). */

export interface HelpSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

export function HelpPage({ description, sections }: { description: string; sections: HelpSection[] }) {
  return (
    <>
      <PageHeader title="Help" description={description} />
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-12">
        <nav aria-label="On this page" className="lg:sticky lg:top-8 lg:w-56 lg:shrink-0">
          <p className="mb-2 text-[13px] font-medium text-text-muted">On this page</p>
          <ul className="flex flex-col gap-1 text-[15px]">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-ink hover:underline underline-offset-4">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex max-w-[72ch] min-w-0 flex-col gap-8">
          {sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="scroll-mt-20">
              <h2 id={`${s.id}-title`} className="mb-2 text-xl leading-7 font-semibold">
                {s.title}
              </h2>
              <div className="flex flex-col gap-3 text-[15px] leading-6 [&_li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">{s.body}</div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

export function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-ink underline underline-offset-4">
      {children}
    </Link>
  );
}
