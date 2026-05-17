"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/session";
import {
  loadSettings,
  saveSettings,
  TELEGRAM_EVENT_KEYS,
  type AppSettings,
  type TelegramEventKey,
} from "@/lib/settings";

const SETTINGS_PATH = "/admin/settings";

function fail(section: string, msg: string): never {
  redirect(`${SETTINGS_PATH}?section=${section}&error=${encodeURIComponent(msg)}`);
}

function ok(section: string): never {
  redirect(`${SETTINGS_PATH}?section=${section}&saved=1`);
}

function parsePositiveInt(
  raw: FormDataEntryValue | null,
  field: string,
  section: string,
  opts: { min?: number; max?: number; allowZero?: boolean } = {},
): number {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) fail(section, `${field} is required`);
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    fail(section, `${field} must be an integer`);
  }
  const min = opts.min ?? (opts.allowZero ? 0 : 1);
  if (n < min) fail(section, `${field} must be at least ${min}`);
  if (opts.max !== undefined && n > opts.max) {
    fail(section, `${field} must be at most ${opts.max}`);
  }
  return n;
}

function parseOptionalPositiveInt(
  raw: FormDataEntryValue | null,
  field: string,
  section: string,
): number | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    fail(section, `${field} must be a positive integer or blank`);
  }
  return n;
}

function parseBool(form: FormData, field: string): boolean {
  return form.get(field) === "on";
}

export async function saveStorageSettings(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "storage";
  const max_gb = parsePositiveInt(form.get("max_gb"), "Max GB", section, {
    min: 1,
    max: 1_000_000,
  });
  const warning_threshold_pct = parsePositiveInt(
    form.get("warning_threshold_pct"),
    "Warning threshold",
    section,
    { min: 1, max: 100 },
  );
  const block_uploads_when_full = parseBool(form, "block_uploads_when_full");
  await saveSettings(
    {
      storage: { max_gb, warning_threshold_pct, block_uploads_when_full },
    },
    owner.userId,
  );
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function saveRetentionSettings(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "retention";
  const view_events_days = parsePositiveInt(
    form.get("view_events_days"),
    "View events retention",
    section,
    { min: 1, max: 3650 },
  );
  const expired_share_links_days = parsePositiveInt(
    form.get("expired_share_links_days"),
    "Expired share-links retention",
    section,
    { min: 1, max: 3650 },
  );
  const export_zips_hours = parsePositiveInt(
    form.get("export_zips_hours"),
    "Export zip TTL",
    section,
    { min: 1, max: 24 * 90 },
  );
  await saveSettings(
    {
      retention: {
        view_events_days,
        expired_share_links_days,
        export_zips_hours,
      },
    },
    owner.userId,
  );
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function saveShareLinkDefaults(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "share_links";
  const default_expiry_days = parseOptionalPositiveInt(
    form.get("default_expiry_days"),
    "Default expiry days",
    section,
  );
  const default_allow_download = parseBool(form, "default_allow_download");
  const default_require_password = parseBool(form, "default_require_password");
  await saveSettings(
    {
      share_links: {
        default_expiry_days,
        default_allow_download,
        default_require_password,
      },
    },
    owner.userId,
  );
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function saveTelegramSettings(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "telegram";
  const current = await loadSettings();

  const chat_id =
    typeof form.get("chat_id") === "string"
      ? (form.get("chat_id") as string).trim()
      : "";
  const enabled = parseBool(form, "enabled");

  const events: TelegramEventKey[] = [];
  for (const key of TELEGRAM_EVENT_KEYS) {
    if (form.get(`event_${key}`) === "on") events.push(key);
  }

  // F8: when TELEGRAM_BOT_TOKEN is set in the environment the worker
  // already uses it as the source of truth — refuse to also persist a
  // copy in app_settings (plaintext at rest) so a DB dump can't leak it.
  const envTokenSet = (process.env.TELEGRAM_BOT_TOKEN ?? "").length > 0;
  const replaceToken = form.get("replace_token") === "1";
  const incomingToken =
    typeof form.get("bot_token") === "string"
      ? (form.get("bot_token") as string).trim()
      : "";
  let bot_token = envTokenSet ? "" : current.telegram.bot_token;
  if (envTokenSet && incomingToken.length > 0) {
    fail(section, "Token is set via TELEGRAM_BOT_TOKEN env var; clear it there");
  }
  if (!envTokenSet && replaceToken) {
    if (incomingToken.length === 0) {
      fail(section, "Provide a token or cancel the replacement");
    }
    bot_token = incomingToken;
  }

  // For the "enabled" precondition: prefer env over DB.
  const effectiveTokenLen = envTokenSet
    ? (process.env.TELEGRAM_BOT_TOKEN ?? "").length
    : bot_token.length;
  if (enabled && (effectiveTokenLen === 0 || chat_id.length === 0)) {
    fail(section, "Token and chat id are required to enable Telegram");
  }

  await saveSettings(
    {
      telegram: { bot_token, chat_id, enabled, events },
    },
    owner.userId,
  );
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function clearTelegramToken(): Promise<void> {
  const owner = await requireOwner();
  const section = "telegram";
  const current = await loadSettings();
  const next: AppSettings["telegram"] = {
    ...current.telegram,
    bot_token: "",
    enabled: false,
  };
  await saveSettings({ telegram: next }, owner.userId);
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function saveMaintenance(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "maintenance";
  const enabled = parseBool(form, "enabled");
  await saveSettings({ maintenance: { enabled } }, owner.userId);
  revalidatePath(SETTINGS_PATH);
  ok(section);
}

export async function saveUploadLimits(form: FormData): Promise<void> {
  const owner = await requireOwner();
  const section = "uploads";
  const max_file_size_mb = parsePositiveInt(
    form.get("max_file_size_mb"),
    "Max file size",
    section,
    { min: 1, max: 10_000 },
  );
  const max_files_per_album = parsePositiveInt(
    form.get("max_files_per_album"),
    "Max files per album",
    section,
    { min: 1, max: 1_000_000 },
  );
  await saveSettings(
    {
      uploads: { max_file_size_mb, max_files_per_album },
    },
    owner.userId,
  );
  revalidatePath(SETTINGS_PATH);
  ok(section);
}
