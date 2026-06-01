import { open } from "maxmind";
import type { Reader, CityResponse } from "maxmind";

/**
 * City-level GeoIP resolution backed by a MaxMind GeoLite2-City database.
 *
 * The .mmdb file is NOT in the repo (it needs a free MaxMind license and
 * periodic updates). Point `GEOIP_DB_PATH` at a GeoLite2-City.mmdb to enable
 * city/region lookups. When it's unset or unreadable, lookups return nulls
 * and callers fall back to the Cloudflare `cf-ipcountry` value captured at
 * view time — so the feature degrades to country-level rather than breaking.
 *
 * Lookups happen only in the owner-only metrics drill-down (for the handful
 * of distinct IPs being displayed), never on the visitor hot path, so the
 * reader is opened lazily and cached for the process lifetime.
 */
let readerPromise: Promise<Reader<CityResponse> | null> | null = null;

function getReader(): Promise<Reader<CityResponse> | null> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const path = process.env.GEOIP_DB_PATH;
      if (!path) return null;
      try {
        return await open<CityResponse>(path);
      } catch (err) {
        console.error("[geoip] failed to open GEOIP_DB_PATH", path, err);
        return null;
      }
    })();
  }
  return readerPromise;
}

/** True when a GeoIP database is configured and loadable. */
export async function geoipAvailable(): Promise<boolean> {
  return (await getReader()) !== null;
}

export interface GeoInfo {
  /** ISO 3166-1 alpha-2 country code, e.g. "UA". */
  country: string | null;
  city: string | null;
  region: string | null;
}

export async function lookupGeo(ip: string | null | undefined): Promise<GeoInfo> {
  const empty: GeoInfo = { country: null, city: null, region: null };
  if (!ip || ip === "unknown") return empty;
  const reader = await getReader();
  if (!reader) return empty;
  try {
    const r = reader.get(ip);
    if (!r) return empty;
    return {
      country: r.country?.iso_code ?? null,
      city: r.city?.names?.en ?? null,
      region: r.subdivisions?.[0]?.names?.en ?? null,
    };
  } catch {
    return empty;
  }
}

/** Resolve geo for many IPs at once (drill-down enrichment). */
export async function lookupGeoBatch(ips: string[]): Promise<Map<string, GeoInfo>> {
  const out = new Map<string, GeoInfo>();
  const reader = await getReader();
  for (const ip of ips) {
    if (!reader || !ip || ip === "unknown") {
      out.set(ip, { country: null, city: null, region: null });
      continue;
    }
    out.set(ip, await lookupGeo(ip));
  }
  return out;
}
