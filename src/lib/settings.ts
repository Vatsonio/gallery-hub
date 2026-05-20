import { sql } from "@/lib/db";

export type TelegramEventKey =
  | "first_share_view"
  | "favorites_burst"
  | "export_started"
  | "export_completed"
  | "storage_warning";

export const TELEGRAM_EVENT_KEYS: readonly TelegramEventKey[] = [
  "first_share_view",
  "favorites_burst",
  "export_started",
  "export_completed",
  "storage_warning",
] as const;

export interface StorageSettings {
  max_gb: number;
  warning_threshold_pct: number;
  block_uploads_when_full: boolean;
}

export interface RetentionSettings {
  view_events_days: number;
  expired_share_links_days: number;
  export_zips_hours: number;
}

export interface ShareLinkDefaults {
  default_expiry_days: number | null;
  default_allow_download: boolean;
  default_require_password: boolean;
}

export interface TelegramSettings {
  bot_token: string;
  chat_id: string;
  enabled: boolean;
  events: TelegramEventKey[];
}

export interface MaintenanceSettings {
  enabled: boolean;
}

export interface UploadLimits {
  max_file_size_mb: number;
  max_files_per_album: number;
  /**
   * Per-album storage cap in GB. Sum of `orig_bytes` of ready+processing
   * photos in the album. 0 = disabled (no cap). Enforced by
   * /api/upload/presign — once an album's photos exceed this, new
   * presigns return 507 Insufficient Storage.
   */
  max_album_gb: number;
  /**
   * Default per-user TOTAL quota in GB (sum across every album the user
   * uploaded into). 0 = unlimited. Per-user override lives on
   * admin_users.quota_total_bytes; this default kicks in only when that
   * column is NULL.
   */
  default_user_quota_total_gb: number;
  /**
   * Default per-user PER-ALBUM quota in GB. Same fallback semantics as
   * default_user_quota_total_gb.
   */
  default_user_quota_album_gb: number;
}

export interface AppSettings {
  storage: StorageSettings;
  retention: RetentionSettings;
  share_links: ShareLinkDefaults;
  telegram: TelegramSettings;
  maintenance: MaintenanceSettings;
  uploads: UploadLimits;
}

export const DEFAULT_SETTINGS: AppSettings = {
  storage: {
    max_gb: 100,
    warning_threshold_pct: 80,
    block_uploads_when_full: false,
  },
  retention: {
    view_events_days: 90,
    expired_share_links_days: 30,
    export_zips_hours: 24,
  },
  share_links: {
    default_expiry_days: null,
    default_allow_download: true,
    default_require_password: false,
  },
  telegram: {
    bot_token: "",
    chat_id: "",
    enabled: false,
    events: [...TELEGRAM_EVENT_KEYS],
  },
  maintenance: {
    enabled: false,
  },
  uploads: {
    max_file_size_mb: 50,
    max_files_per_album: 500,
    max_album_gb: 0,
    default_user_quota_total_gb: 0,
    default_user_quota_album_gb: 0,
  },
};

type SectionKey = keyof AppSettings;

const SECTION_KEYS: readonly SectionKey[] = [
  "storage",
  "retention",
  "share_links",
  "telegram",
  "maintenance",
  "uploads",
];

interface CacheEntry {
  value: AppSettings;
  expiresAt: number;
}
const TTL_MS = 5 * 60 * 1000;
const cache: { entry: CacheEntry | null } = { entry: null };

function invalidateCache(): void {
  cache.entry = null;
}

function mergeSection<K extends SectionKey>(
  key: K,
  stored: unknown,
): AppSettings[K] {
  const defaults = DEFAULT_SETTINGS[key];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...defaults };
  }
  return { ...defaults, ...(stored as object) } as AppSettings[K];
}

function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

export async function loadSettings(): Promise<AppSettings> {
  const now = Date.now();
  if (cache.entry && cache.entry.expiresAt > now) {
    return cache.entry.value;
  }
  const rows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM app_settings
  `;
  const merged: AppSettings = {
    storage: { ...DEFAULT_SETTINGS.storage },
    retention: { ...DEFAULT_SETTINGS.retention },
    share_links: { ...DEFAULT_SETTINGS.share_links },
    telegram: {
      ...DEFAULT_SETTINGS.telegram,
      events: [...DEFAULT_SETTINGS.telegram.events],
    },
    maintenance: { ...DEFAULT_SETTINGS.maintenance },
    uploads: { ...DEFAULT_SETTINGS.uploads },
  };
  for (const row of rows) {
    if (!isSectionKey(row.key)) continue;
    if (row.key === "telegram") {
      const v = row.value as Partial<TelegramSettings> | null;
      if (v && typeof v === "object") {
        merged.telegram = {
          bot_token: typeof v.bot_token === "string" ? v.bot_token : "",
          chat_id: typeof v.chat_id === "string" ? v.chat_id : "",
          enabled: v.enabled === true,
          events: Array.isArray(v.events)
            ? (v.events.filter((e): e is TelegramEventKey =>
                (TELEGRAM_EVENT_KEYS as readonly string[]).includes(String(e)),
              ) as TelegramEventKey[])
            : [...DEFAULT_SETTINGS.telegram.events],
        };
      }
      continue;
    }
    if (row.key === "storage") {
      merged.storage = mergeSection("storage", row.value);
      continue;
    }
    if (row.key === "retention") {
      merged.retention = mergeSection("retention", row.value);
      continue;
    }
    if (row.key === "share_links") {
      merged.share_links = mergeSection("share_links", row.value);
      continue;
    }
    if (row.key === "maintenance") {
      merged.maintenance = mergeSection("maintenance", row.value);
      continue;
    }
    if (row.key === "uploads") {
      merged.uploads = mergeSection("uploads", row.value);
    }
  }
  cache.entry = { value: merged, expiresAt: now + TTL_MS };
  return merged;
}

export async function saveSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
  updatedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (${key as string}, ${sql.json(value as never)}, NOW(), ${updatedBy})
    ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
  `;
  invalidateCache();
}

export async function saveSettings(
  partial: Partial<AppSettings>,
  updatedBy: string,
): Promise<void> {
  const entries = Object.entries(partial).filter(
    ([, v]) => v !== undefined,
  ) as [keyof AppSettings, AppSettings[keyof AppSettings]][];
  if (entries.length === 0) return;
  for (const [k, v] of entries) {
    await sql`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES (${k as string}, ${sql.json(v as never)}, NOW(), ${updatedBy})
      ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by
    `;
  }
  invalidateCache();
}

export function maskTokenTail(token: string): string {
  if (!token) return "";
  if (token.length <= 4) return token;
  return token.slice(-4);
}
