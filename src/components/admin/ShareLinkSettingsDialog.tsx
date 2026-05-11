"use client";
import { useState, useTransition } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateShareLink, revokeShareLink } from "@/lib/share-actions";

interface Props {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  token: string;
  initial: { expiresAt: string | null; allowDownload: boolean; hasPassword: boolean };
}

export function ShareLinkSettingsDialog({ open, onOpenChange, token, initial }: Props) {
  const [allowDownload, setAllowDownload] = useState(initial.allowDownload);
  const [expiresAt, setExpiresAt] = useState<string>(initial.expiresAt ? initial.expiresAt.slice(0, 10) : "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = () => startTransition(async () => {
    await updateShareLink(token, {
      allowDownload,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      newPassword: clearPassword ? null : (password ? password : undefined),
    });
    onOpenChange(false);
  });

  const revoke = () => startTransition(async () => {
    if (!confirm("Revoke this share link? Anyone with the URL will lose access.")) return;
    await revokeShareLink(token);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-950 border-white/10 text-white">
        <DialogHeader><DialogTitle>Share-link settings</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)} />
            Allow downloads
          </label>
          <div>
            <label className="block text-sm text-white/70">Expires</label>
            <Input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm text-white/70">Password (leave blank to keep current)</label>
            <Input type="password" value={password} disabled={clearPassword} onChange={e => setPassword(e.target.value)} />
            {initial.hasPassword && (
              <label className="mt-1 flex items-center gap-2 text-xs cursor-pointer text-white/60">
                <input type="checkbox" checked={clearPassword} onChange={e => setClearPassword(e.target.checked)} />
                Remove password protection
              </label>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="cursor-pointer text-rose-300 hover:text-rose-200" onClick={revoke} disabled={pending}>Revoke link</Button>
          <Button className="cursor-pointer bg-rose-500 hover:bg-rose-400 text-white" onClick={save} disabled={pending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
