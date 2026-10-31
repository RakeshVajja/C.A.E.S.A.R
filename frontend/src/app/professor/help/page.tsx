import { HelpLink, HelpPage } from "@/components/help";

/** Guidance for professors (More menu → Help). Describes only the workflows the application provides. */
export default function ProfessorHelpPage() {
  return (
    <HelpPage
      description="How CSE Research Hub collects your publications and what you do with them."
      sections={[
        {
          id: "how-it-works",
          title: "How your publications are collected",
          body: (
            <>
              <p>
                Once a month the system collects publication metadata from OpenAlex, DBLP, ORCID, Scopus and Web of Science through the identities the
                administrator verified for you. Where Scopus reports a citation count, it is shown with the publication, with links to Scopus.
                Records that describe the same paper are combined into one publication, so a paper reported by several sources appears once, with every source
                shown.
              </p>
              <p>Only metadata is kept — titles, years, venues, authors and DOIs. No PDFs, abstracts or full texts are stored.</p>
            </>
          ),
        },
        {
          id: "verify",
          title: "Verifying publications",
          body: (
            <>
              <p>
                New publications wait in <HelpLink href="/professor/pending">Pending</HelpLink> until you decide. Only approved publications form your verified
                list.
              </p>
              <ul>
                <li>
                  <strong className="font-medium">Approve</strong> a publication that is yours; <strong className="font-medium">Reject</strong> one that is not.
                  Rejecting removes it only from your list, never for co-authors.
                </li>
                <li>Every decision can be changed later from the same list (Approved or Rejected tab).</li>
                <li>A rejected publication stays rejected after later synchronizations.</li>
                <li>
                  To approve many at once, tick their boxes (or use “Select all pending”) and choose <strong className="font-medium">Approve selected</strong>.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "add",
          title: "Adding a missing publication",
          body: (
            <>
              <p>
                Use <HelpLink href="/professor/add">Add publication</HelpLink> for work the sources missed. Give the title and type, and the DOI if there is one
                — it is the most reliable way to match an existing publication. Say where the details come from (the publisher, a repository or your own
                records, or the citation database you copied them from) and give a DOI or a link as evidence.
              </p>
              <p>
                If the publication already exists it is reused rather than duplicated, and it is added to your approved list. When a similar but not identical
                publication exists, the administrator is asked to check whether they are the same.
              </p>
            </>
          ),
        },
        {
          id: "problems",
          title: "Something looks wrong",
          body: (
            <ul>
              <li>
                <strong className="font-medium">A publication is not yours:</strong> reject it.
              </li>
              <li>
                <strong className="font-medium">A publication is missing:</strong> add it yourself; it may also appear after the next monthly synchronization.
              </li>
              <li>
                <strong className="font-medium">Wrong metadata, a duplicate entry, or a wrong external identity:</strong> tell the department administrator.
                They can correct publication details, merge duplicates and fix your identities.
              </li>
            </ul>
          ),
        },
        {
          id: "account",
          title: "Your account",
          body: (
            <ul>
              <li>
                You can change your name in <HelpLink href="/professor/profile">Profile</HelpLink>. Department, designation and login email are managed by the
                administrator.
              </li>
              <li>
                Your first sign-in uses the temporary password from your sign-in email. It works for 7 days and must be replaced by your own password; if it has
                expired, ask the department administrator to send new sign-in details.
              </li>
              <li>
                Change your password with <HelpLink href="/change-password">Change password</HelpLink> in the account area. If you forget it, use “Forgot
                password?” on the sign-in page to receive a code by email.
              </li>
              <li>The More menu (⋯) lets you choose a light or dark appearance, or follow your system setting.</li>
            </ul>
          ),
        },
      ]}
    />
  );
}
