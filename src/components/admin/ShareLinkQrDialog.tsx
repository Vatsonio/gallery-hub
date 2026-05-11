"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ShareLinkQrDialog({ open, onOpenChange, url }: { open: boolean; onOpenChange: (b: boolean) => void; url: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(url, { margin: 1, width: 512, color: { dark: "#0a0a0a", light: "#ffffff" } }).then(setDataUrl);
  }, [open, url]);

  const download = () => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "share-qr.png";
    a.click();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10">
        <DialogHeader><DialogTitle className="text-white">Scan to open</DialogTitle></DialogHeader>
        <div className="flex flex-col items-center gap-4 p-2">
          {dataUrl ? <img src={dataUrl} alt="QR code" className="h-72 w-72 rounded-lg" /> : <div className="h-72 w-72 bg-white/5 rounded-lg" />}
          <Button className="cursor-pointer bg-rose-500 hover:bg-rose-400 text-white" disabled={!dataUrl} onClick={download}>Download PNG</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
