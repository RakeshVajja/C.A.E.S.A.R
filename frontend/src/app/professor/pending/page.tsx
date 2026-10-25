import { Suspense } from "react";
import { PublicationReview } from "@/components/publication-review";
import { PageHeader, SkeletonRows } from "@/components/ui";

export default function PendingPage() {
  return (
    <>
      <PageHeader
        title="Pending verification"
        description="Publications found by synchronization wait for your decision. Approved publications form your verified list; every decision can be changed later."
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <PublicationReview defaultStatus="PENDING" />
      </Suspense>
    </>
  );
}
