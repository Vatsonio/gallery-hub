"use client";

import { useState, useTransition } from "react";
import { Copy, QrCode, Settings, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShareLinkSettingsDialog } from "./ShareLinkSettingsDialog";
import { ShareLinkQrDialog } from "./ShareLinkQrDialog";
import { useToast } from "@/components/ui/Toast";

export interface ShareLinkCardProps {
  publicBaseUrl: string;
  link: {
    token: string;
    expiresAt: string | null;
    allowDownload: boolean;
    hasPassword: boolean;
    viewCount: number;
    favoriteCount: number;
  } | null;
  albumId: string;
  onCreate: () => Promise<void>;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-0.5 ${accent ? "text-rose-300" : "text-white"}`}>{value}</div>
    </div>
  );
}

export function ShareLinkCard({ publicBaseUrl, link, onCreate }: ShareLinkCardProps) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!link) {
    return (
      <div className="rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-rose-500/5 p-6">
        <h3 className="text-lg font-medium text-white">No share link yet</h3>
        <p className="mt-1 text-sm text-white/60">Generate a public URL clients can use to view this album.</p>
        <Button
          className="mt-4 cursor-pointer bg-rose-500 hover:bg-rose-400 text-white"
          disabled={pending}
          onClick={() => startTransition(() => onCreate())}
        >
          Create share link
        </Button>
      </div>
    );
  }

  const url = `${publicBaseUrl}/a/${link.token}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-rose-500/5 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-rose-300/80">Share link</div>
          <div className="mt-1 truncate font-mono text-lg text-white">{url}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Copy URL" onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Show QR code" onClick={() => setShowQr(true)}>
            <QrCode className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="cursor-pointer text-white/80 hover:text-white" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 text-sm text-white/70 sm:grid-cols-4">
        <Stat label="Expires" value={link.expiresAt ? new Date(link.expiresAt).toLocaleDateString() : "Never"} />
        <Stat label="Views" value={link.viewCount.toString()} />
        <Stat label="Favorites" value={link.favoriteCount.toString()} accent />
        <Stat label="Password" value={link.hasPassword ? "On" : "Off"} />
      </div>
      <ShareLinkSettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        token={link.token}
        initial={{ expiresAt: link.expiresAt, allowDownload: link.allowDownload, hasPassword: link.hasPassword }}
      />
      <ShareLinkQrDialog open={showQr} onOpenChange={setShowQr} url={url} />
    </div>
  );
}
