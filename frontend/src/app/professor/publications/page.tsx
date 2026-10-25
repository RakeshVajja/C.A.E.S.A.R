import { Suspense } from "react";
import { FilePlus2 } from "lucide-react";
import { PublicationReview } from "@/components/publication-review";
import { ButtonLink, PageHeader, SkeletonRows } from "@/components/ui";

export default function MyPublicationsPage() {
  return (
    <>
      <PageHeader
        title="My publications"
        description="Your verified (approved) publications, and the ones you rejected. Each publication is shown once, with every source that reported it."
        actions={
          <ButtonLink href="/professor/add" variant="primary" icon={<FilePlus2 aria-hidden size={18} />}>
            Add publication
          </ButtonLink>
        }
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <PublicationReview defaultStatus="APPROVED" />
      </Suspense>
    </>
  );
}
