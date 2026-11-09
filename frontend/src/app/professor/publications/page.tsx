"use client";

import { Suspense, useState } from "react";
import { FileDown, FilePlus2 } from "lucide-react";
import { PublicationReview } from "@/components/publication-review";
import { useToast } from "@/components/toast";
import { Button, ButtonLink, PageHeader, SkeletonRows } from "@/components/ui";
import { downloadFile, errorMessage } from "@/lib/api";

/**
 * My publications: the professor's approved publications only. Rejections are reviewed and
 * reversed under Pending's Rejected tab (§11). The approved list can be downloaded as a CSV file
 * with canonical metadata only (decision #153).
 */
export default function MyPublicationsPage() {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      await downloadFile("/me/publications/export", "my-approved-publications.csv");
    } catch (error) {
      toast(`The download failed: ${errorMessage(error)}`, "danger");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="My publications"
        description="Your verified (approved) publications. Each publication is shown once, with every source that reported it. Publications you rejected are under Pending, where you can still change your decision."
        actions={
          <ButtonLink href="/professor/add" variant="primary" icon={<FilePlus2 aria-hidden size={18} />}>
            Add publication
          </ButtonLink>
        }
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <PublicationReview
          defaultStatus="APPROVED"
          statuses={["APPROVED"]}
          toolbar={
            <Button
              compact
              icon={<FileDown aria-hidden size={16} />}
              onClick={() => void download()}
              loading={downloading}
              aria-label={downloading ? "Preparing the CSV download" : "Download as CSV"}
              title="Download as CSV"
            />
          }
        />
      </Suspense>
    </>
  );
}
