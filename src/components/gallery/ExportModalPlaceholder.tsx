"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Placeholder modal for the export pipeline. The real ZIP-generation
 * worker + signed download flow lands in M4; this UI just documents
 * the three planned options so the dock CTA does something visible.
 */
export default function ExportModalPlaceholder({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2 text-sm text-white/70">
          <p>Three export options land in the next release:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Favorites only (originals)</li>
            <li>Whole album (web-size, 2400px max)</li>
            <li>Whole album (originals)</li>
          </ul>
          <p className="text-xs text-white/40">
            ZIPs are cached for 24h after first generation.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
