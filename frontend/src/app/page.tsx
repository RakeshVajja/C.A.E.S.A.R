"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Alert, Button, Skeleton } from "@/components/ui";
import { homeFor, useAuth } from "@/lib/auth";

/** Entry point: routes to sign-in, the forced password change, or the role's dashboard. */
export default function Home() {
  const { status, user, refresh } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "signedOut") router.replace("/login");
    if (status === "signedIn" && user) router.replace(user.mustChangePassword ? "/change-password" : homeFor(user.role));
  }, [status, user, router]);

  return (
    <main id="main" className="mx-auto max-w-lg px-4 pt-16">
      {status === "unavailable" ? (
        <Alert
          tone="danger"
          role="alert"
          title="The server could not be reached"
          action={
            <Button compact onClick={() => void refresh()}>
              Try again
            </Button>
          }
        >
          Check that the backend is running, then try again.
        </Alert>
      ) : (
        <div role="status" aria-label="Loading">
          <Skeleton className="h-8 w-48" />
        </div>
      )}
    </main>
  );
}
