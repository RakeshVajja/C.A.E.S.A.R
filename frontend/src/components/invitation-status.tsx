import { Alert } from "./ui";
import type { InvitationStatus } from "@/lib/types";

/**
 * Result of emailing a professor's sign-in details (decision #102). The temporary password goes only
 * to the professor; the administrator sees whether it was sent.
 */
export function InvitationNotice({ status, email }: { status: InvitationStatus; email: string }) {
  if (status === "SENT") {
    return (
      <Alert tone="success" role="status" title="Sign-in details emailed">
        A temporary password was sent to <span className="[overflow-wrap:anywhere]">{email}</span>. It works for 7 days and must be changed at first sign-in.
      </Alert>
    );
  }
  if (status === "NOT_CONFIGURED") {
    return (
      <Alert tone="warning" role="status" title="Email is not configured">
        No email was sent because SMTP is not configured on the server. The account is kept; configure SMTP, then use “Resend sign-in email”.
      </Alert>
    );
  }
  return (
    <Alert tone="danger" role="alert" title="Sign-in details could not be sent">
      The email to <span className="[overflow-wrap:anywhere]">{email}</span> did not go through. The account is kept; use “Resend sign-in email” to try again.
    </Alert>
  );
}
