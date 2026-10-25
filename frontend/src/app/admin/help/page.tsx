import { HelpLink, HelpPage } from "@/components/help";

/** Guidance for the administrator (More menu → Help). Describes only the workflows the application provides. */
export default function AdminHelpPage() {
  return (
    <HelpPage
      description="Running the department’s publication register: professors, synchronization, data quality and analytics."
      sections={[
        {
          id: "professors",
          title: "Professors and identities",
          body: (
            <ol>
              <li>
                Add a professor in <HelpLink href="/admin/professors">Professors</HelpLink>. Their sign-in details — a temporary password valid for 7 days — are
                emailed to them; you never see the password. They must choose their own password at first sign-in. If the email could not be sent, or the
                password expired, open the professor and use “Resend sign-in email”.
              </li>
              <li>
                Open the professor and add their OpenAlex, DBLP or ORCID identities. Each identifier is checked with its source first — confirm the name and
                works before saving.
              </li>
              <li>
                Deactivating or removing an identity removes the pending publications found only through it; approved and rejected ones are kept. Deactivating a
                professor stops sign-in and synchronization but keeps all data.
              </li>
            </ol>
          ),
        },
        {
          id: "sync",
          title: "Synchronization",
          body: (
            <>
              <p>
                Publications are collected automatically on the first of every month, and you can start a run in{" "}
                <HelpLink href="/admin/sync">Synchronization</HelpLink>. Each identity is fetched in turn; a source that fails affects only that identity and
                never deletes or changes existing data. New publications appear as pending for their professors.
              </p>
              <p>Merging and detaching are not available while a run is in progress.</p>
            </>
          ),
        },
        {
          id: "quality",
          title: "Keeping the data correct",
          body: (
            <ul>
              <li>
                <strong className="font-medium">Possible duplicates</strong> that were not merged automatically wait in{" "}
                <HelpLink href="/admin/duplicates">Duplicates</HelpLink>. Compare both, then keep one and merge, or dismiss if they are different papers.
              </li>
              <li>
                <strong className="font-medium">Wrong metadata:</strong> open the publication in <HelpLink href="/admin/publications">Publications</HelpLink>{" "}
                and edit it. Edited publications are curated, so synchronization keeps your corrections.
              </li>
              <li>
                <strong className="font-medium">A source record attached to the wrong paper:</strong> detach it on the publication page; it becomes a separate
                publication.
              </li>
              <li>
                <strong className="font-medium">An incorrect publication:</strong> suppress it instead of deleting it. It disappears for professors and from
                analytics and can be restored later.
              </li>
            </ul>
          ),
        },
        {
          id: "analytics",
          title: "Reading the analytics",
          body: (
            <p>
              <HelpLink href="/admin/analytics">Analytics</HelpLink> counts publications approved by at least one professor that are neither suppressed nor
              preprints. Each publication counts once in the totals; per-professor figures count it for every co-author, so they can add up to more than the
              total.
            </p>
          ),
        },
        {
          id: "account",
          title: "Administrator account",
          body: (
            <ul>
              <li>
                Change your password with <HelpLink href="/change-password">Change password</HelpLink> in the account area.
              </li>
              <li>The administrator password cannot be recovered by email; it is reset with the backend command-line tool on the server.</li>
              <li>The More menu (⋯) lets you choose a light or dark appearance, or follow your system setting.</li>
            </ul>
          ),
        },
      ]}
    />
  );
}
