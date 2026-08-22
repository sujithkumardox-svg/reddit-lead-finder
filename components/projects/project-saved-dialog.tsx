"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ProjectSavedDialogProps = {
  open: boolean;
  starting: boolean;
  onFindCustomers: () => void;
};

export function ProjectSavedDialog({
  open,
  starting,
  onFindCustomers,
}: ProjectSavedDialogProps) {
  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="border-white/10 bg-neutral-900 text-white sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="text-white">Project saved</DialogTitle>
          <DialogDescription className="text-neutral-400">
            Your project is ready. Start the first scan when you want to find
            Reddit customers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-white/10 bg-transparent">
          <Button
            type="button"
            size="lg"
            disabled={starting}
            onClick={onFindCustomers}
            className="h-11 w-full rounded-xl bg-orange-500 font-semibold text-white hover:bg-orange-600"
          >
            Find your Reddit customers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
