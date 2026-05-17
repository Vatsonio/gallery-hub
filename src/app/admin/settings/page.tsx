import {
  Settings as SettingsIcon,
  HardDrive,
  Clock,
  Link2,
  Send,
  Wrench,
  UploadCloud,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { requireOwner } from "@/lib/auth-check";
import {
  loadSettings,
  maskTokenTail,
  TELEGRAM_EVENT_KEYS,
  type TelegramEventKey,
} from "@/lib/settings";
import { getStorageUsage } from "@/lib/storage-usage";
import { StorageUsageMeter } from "@/components/admin/StorageUsageMeter";
import {
  saveStorageSettings,
  saveRetentionSettings,
  saveShareLinkDefaults,
  saveTelegramSettings,
  clearTelegramToken,
  saveMaintenance,
  saveUploadLimits,
} from "./_actions";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ error?: string; saved?: string; section?: string }>;
}

const EVENT_LABELS: Record<TelegramEventKey, string> = {
  first_share_view: "First share view",
  favorites_burst: "Favorites burst",
  export_started: "Export started",
  export_completed: "Export completed",
  storage_warning: "Storage warning",
};

const inputCls =
  "w-full rounded-md bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent tabular-nums";
const labelCls = "text-xs uppercase tracking-wider text-text-muted";
const cardCls =
  "rounded-2xl border border-line bg-bg-elevated p-6 space-y-5";
const sectionHeader = "flex items-center gap-3 mb-1";
const saveBtn =
  "rounded-lg bg-rose-accent hover:bg-rose-hover transition px-4 py-2 text-sm font-medium cursor-pointer text-white";
const altBtn =
  "rounded-lg bg-bg-card hover:bg-white/5 border border-line transition px-3 py-2 text-sm cursor-pointer";

function Banner({
  kind,
  msg,
}: {
  kind: "error" | "ok";
  msg: string;
}): React.JSX.Element {
  const isErr = kind === "error";
  return (
    <div
      role={isErr ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
        isErr
          ? "border-rose-500/30 bg-rose-500/5 text-rose-300"
          : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
      }`}
    >
      {isErr ? (
        <AlertTriangle className="size-4 mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 className="size-4 mt-0.5 shrink-0" />
      )}
      <span>{msg}</span>
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  await requireOwner();
  const sp = await searchParams;
  const [settings, usage] = await Promise.all([
    loadSettings(),
    getStorageUsage(),
  ]);

  const maxBytes = settings.storage.max_gb * 1_000_000_000;
  const sectionErr = sp.error ?? null;
  const sectionSaved = sp.saved === "1";
  const activeSection = sp.section ?? null;

  const tokenSet = settings.telegram.bot_token.length > 0;
  const tokenTail = maskTokenTail(settings.telegram.bot_token);

  function bannerFor(section: string): React.JSX.Element | null {
    if (activeSection !== section) return null;
    if (sectionErr) return <Banner kind="error" msg={sectionErr} />;
    if (sectionSaved) return <Banner kind="ok" msg="Saved" />;
    return null;
  }

  return (
    <div className="p-6 max-w-screen-lg space-y-8">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
          <SettingsIcon className="h-4 w-4" />
        </span>
        <div>
          <h1 className="text-2xl font-light text-white">Settings</h1>
          <p className="text-sm text-text-muted">
            System-wide configuration. Owner only.
          </p>
        </div>
      </div>

      {/* Storage */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <HardDrive className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Storage</h2>
        </div>
        <StorageUsageMeter
          usedBytes={usage.usedBytes}
          maxBytes={maxBytes}
          warningPct={settings.storage.warning_threshold_pct}
          photoCount={usage.photoCount}
        />
        {bannerFor("storage")}
        <form action={saveStorageSettings} className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Soft cap (GB)</span>
            <input
              type="number"
              name="max_gb"
              defaultValue={settings.storage.max_gb}
              min={1}
              max={1_000_000}
              step={1}
              required
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              Used to compute the usage meter and warning trigger.
            </p>
          </label>
          <label className="block">
            <span className={labelCls}>Warning threshold (%)</span>
            <input
              type="number"
              name="warning_threshold_pct"
              defaultValue={settings.storage.warning_threshold_pct}
              min={1}
              max={100}
              step={1}
              required
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              Meter turns rose and a Telegram alert fires above this percent.
            </p>
          </label>
          <label className="flex items-start gap-3 md:col-span-2">
            <input
              type="checkbox"
              name="block_uploads_when_full"
              defaultChecked={settings.storage.block_uploads_when_full}
              className="mt-1 size-4 accent-rose-500 cursor-pointer"
            />
            <span>
              <span className="text-sm">Hard-block uploads when over the soft cap</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Off by default. When on, uploads return 507 once usage exceeds the soft cap.
              </span>
            </span>
          </label>
          <div className="md:col-span-2 flex justify-end">
            <button type="submit" className={saveBtn}>
              Save storage
            </button>
          </div>
        </form>
      </section>

      {/* Retention */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <Clock className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Retention</h2>
        </div>
        {bannerFor("retention")}
        <form
          action={saveRetentionSettings}
          className="grid gap-4 md:grid-cols-3"
        >
          <label className="block">
            <span className={labelCls}>View events (days)</span>
            <input
              type="number"
              name="view_events_days"
              defaultValue={settings.retention.view_events_days}
              min={1}
              max={3650}
              required
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              view_events older than this are eligible for cleanup.
            </p>
          </label>
          <label className="block">
            <span className={labelCls}>Expired share links (days)</span>
            <input
              type="number"
              name="expired_share_links_days"
              defaultValue={settings.retention.expired_share_links_days}
              min={1}
              max={3650}
              required
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              Share links expired this long ago can be purged.
            </p>
          </label>
          <label className="block">
            <span className={labelCls}>Export zip TTL (hours)</span>
            <input
              type="number"
              name="export_zips_hours"
              defaultValue={settings.retention.export_zips_hours}
              min={1}
              max={2160}
              required
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              Cached export zips on MinIO older than this expire.
            </p>
          </label>
          <div className="md:col-span-3 flex justify-end">
            <button type="submit" className={saveBtn}>
              Save retention
            </button>
          </div>
        </form>
      </section>

      {/* Share link defaults */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <Link2 className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Share link defaults</h2>
        </div>
        {bannerFor("share_links")}
        <form
          action={saveShareLinkDefaults}
          className="grid gap-4 md:grid-cols-3"
        >
          <label className="block">
            <span className={labelCls}>Default expiry (days)</span>
            <input
              type="number"
              name="default_expiry_days"
              defaultValue={settings.share_links.default_expiry_days ?? ""}
              min={1}
              placeholder="no expiry"
              className={`mt-1 ${inputCls}`}
            />
            <p className="mt-1 text-xs text-text-muted">
              Leave blank for links that never expire by default.
            </p>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="default_allow_download"
              defaultChecked={settings.share_links.default_allow_download}
              className="mt-1 size-4 accent-rose-500 cursor-pointer"
            />
            <span>
              <span className="text-sm">Allow download by default</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="default_require_password"
              defaultChecked={settings.share_links.default_require_password}
              className="mt-1 size-4 accent-rose-500 cursor-pointer"
            />
            <span>
              <span className="text-sm">Require password by default</span>
            </span>
          </label>
          <div className="md:col-span-3 flex justify-end">
            <button type="submit" className={saveBtn}>
              Save share defaults
            </button>
          </div>
        </form>
      </section>

      {/* Telegram */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <Send className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Telegram</h2>
        </div>
        {bannerFor("telegram")}
        <form action={saveTelegramSettings} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <span className={labelCls}>Bot token</span>
              {tokenSet ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-md bg-bg-card border border-line px-3 py-2 text-sm">
                    <CheckCircle2 className="size-4 text-emerald-300" />
                    Configured (....{tokenTail})
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
                    <input
                      type="checkbox"
                      name="replace_token"
                      value="1"
                      className="size-4 accent-rose-500"
                    />
                    Replace
                  </label>
                </div>
              ) : (
                <input type="hidden" name="replace_token" value="1" />
              )}
              <input
                type="password"
                name="bot_token"
                autoComplete="off"
                placeholder={
                  tokenSet
                    ? "New token (only saved when Replace is ticked)"
                    : "Paste bot token"
                }
                className={`mt-2 ${inputCls}`}
              />
            </div>
            <label className="block">
              <span className={labelCls}>Chat id</span>
              <input
                type="text"
                name="chat_id"
                defaultValue={settings.telegram.chat_id}
                className={`mt-1 ${inputCls}`}
              />
            </label>
          </div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={settings.telegram.enabled}
              className="mt-1 size-4 accent-rose-500 cursor-pointer"
            />
            <span>
              <span className="text-sm">Telegram notifications enabled</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Requires both a token and chat id.
              </span>
            </span>
          </label>
          <fieldset className="space-y-2">
            <legend className={labelCls}>Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {TELEGRAM_EVENT_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 text-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    name={`event_${key}`}
                    defaultChecked={settings.telegram.events.includes(key)}
                    className="size-4 accent-rose-500"
                  />
                  {EVENT_LABELS[key]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2">
            {tokenSet ? (
              <button
                type="submit"
                formAction={clearTelegramToken}
                className={altBtn}
              >
                Clear token
              </button>
            ) : null}
            <button type="submit" className={saveBtn}>
              Save Telegram
            </button>
          </div>
        </form>
      </section>

      {/* Maintenance */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <Wrench className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Maintenance mode</h2>
        </div>
        {bannerFor("maintenance")}
        <form action={saveMaintenance} className="space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={settings.maintenance.enabled}
              className="mt-1 size-4 accent-rose-500 cursor-pointer"
            />
            <span>
              <span className="text-sm">Enable maintenance mode</span>
              <span className="block text-xs text-text-muted mt-0.5">
                When on, public share routes (/a/*) should serve a maintenance page.
                The gate itself is not yet wired in middleware.
              </span>
            </span>
          </label>
          <div className="flex justify-end">
            <button type="submit" className={saveBtn}>
              Save maintenance
            </button>
          </div>
        </form>
      </section>

      {/* Upload limits */}
      <section className={cardCls}>
        <div className={sectionHeader}>
          <UploadCloud className="size-5 text-rose-300" />
          <h2 className="text-lg font-light text-white">Upload limits</h2>
        </div>
        {bannerFor("uploads")}
        <form action={saveUploadLimits} className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Max file size (MB)</span>
            <input
              type="number"
              name="max_file_size_mb"
              defaultValue={settings.uploads.max_file_size_mb}
              min={1}
              max={10000}
              required
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Max files per album</span>
            <input
              type="number"
              name="max_files_per_album"
              defaultValue={settings.uploads.max_files_per_album}
              min={1}
              max={1_000_000}
              required
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <div className="md:col-span-2 flex justify-end">
            <button type="submit" className={saveBtn}>
              Save upload limits
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
