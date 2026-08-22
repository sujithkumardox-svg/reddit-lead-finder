"use client";

import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getScanProgressLabel } from "@/lib/scans/scan-progress";
import type { ScanProgressStage } from "@/types/sync-logs";

type FindingLeadsDialogProps = {
  open: boolean;
  stage: ScanProgressStage;
  errorMessage: string | null;
  onDismissFailed: () => void;
};

export function FindingLeadsDialog({
  open,
  stage,
  errorMessage,
  onDismissFailed,
}: FindingLeadsDialogProps) {
  const failed = stage === "failed";

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="border-white/10 bg-neutral-900 text-white sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="text-white">
            {failed ? "Scan failed" : "Finding Your Leads"}
          </DialogTitle>
          <DialogDescription className="text-neutral-400">
            {failed
              ? (errorMessage ?? "The scan failed. Please try again.")
              : getScanProgressLabel(stage)}
          </DialogDescription>
        </DialogHeader>
        {!failed && (
          <div className="flex items-center gap-2 text-sm text-orange-400">
            <LoaderCircle className="size-4 animate-spin" />
            {getScanProgressLabel(stage)}
          </div>
        )}
        {failed && (
          <DialogFooter className="border-white/10 bg-transparent">
            <Button
              type="button"
              variant="outline"
              onClick={onDismissFailed}
              className="w-full border-white/15 text-white"
            >
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
