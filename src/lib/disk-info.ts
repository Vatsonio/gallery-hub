import { exec } from "node:child_process";
import { promisify } from "node:util";
import { statfs } from "node:fs/promises";

const execAsync = promisify(exec);

export interface DiskRow {
  source: string;
  fstype: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usePct: number;
}

/**
 * Snapshot of every filesystem the gallery-app process can see. In a
 * containerised prod deploy this is the *container's* view — overlay root
 * plus any volumes mounted into the container. On Proxmox/Linux without
 * Docker, this is the host's full mount table. On Windows dev, df may
 * not exist; we fall back to fs.statfs for "/" so the page still renders.
 */
export async function getDiskInfo(): Promise<DiskRow[]> {
  const viaDf = await tryDf();
  if (viaDf.length > 0) return viaDf;
  return tryStatfsFallback();
}

// BusyBox `df` (Alpine, our prod image) does not support GNU coreutils' `-x`
// flag, so the filter step has to live in JS. These are the pseudo /
// virtual filesystem types that pollute the table with 0-byte rows or
// duplicate /dev/* bind mounts for /etc/resolv.conf, /etc/hostname, etc.
const PSEUDO_FSTYPES = new Set([
  "tmpfs",
  "devtmpfs",
  "squashfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "cgroupv2",
  "mqueue",
  "pstore",
  "bpf",
  "binfmt_misc",
  "autofs",
  "debugfs",
  "tracefs",
  "hugetlbfs",
  "fusectl",
  "securityfs",
  "nsfs",
  "ramfs",
]);

// Inside a container the kernel bind-mounts the host disk into config
// paths like /etc/hostname, /etc/resolv.conf, /etc/hosts. They surface as
// extra `ext4` rows pointing at the same backing device — useless noise
// for a "what disk does the gallery have" view. Plain Linux hosts don't
// have ext4 mounted under /etc/, /dev/, /proc/, /sys/, so this prefix
// filter is safe outside containers too.
const PSEUDO_MOUNT_PREFIXES = ["/etc/", "/dev/", "/proc/", "/sys/", "/run/"];

function isPseudoMount(mount: string): boolean {
  return PSEUDO_MOUNT_PREFIXES.some((p) => mount.startsWith(p));
}

async function tryDf(): Promise<DiskRow[]> {
  try {
    const { stdout } = await execAsync(
      // -P: POSIX one-line-per-fs · -B1: bytes · -T: include fstype.
      // We deliberately omit -x because BusyBox df doesn't accept it;
      // PSEUDO_FSTYPES + the dedupe pass below do the same job in JS so
      // the same code path works on Alpine prod and Debian dev.
      "df -PT -B1",
      { timeout: 5_000 },
    );
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return [];
    const parsed = lines.slice(1).map(parseDfLine).filter((r): r is DiskRow => r !== null);

    const filtered = parsed.filter(
      (r) => !PSEUDO_FSTYPES.has(r.fstype) && !isPseudoMount(r.mount),
    );

    // Dedupe leftover overlap by (source, totalBytes) — picks the shortest
    // mount path so "/" beats any deeper alias. Belt-and-braces on top of
    // the prefix filter above.
    const seen = new Map<string, DiskRow>();
    for (const r of filtered) {
      const key = `${r.source}|${r.totalBytes}`;
      const prev = seen.get(key);
      if (!prev || r.mount.length < prev.mount.length) {
        seen.set(key, r);
      }
    }
    return [...seen.values()].sort((a, b) => a.mount.localeCompare(b.mount));
  } catch {
    return [];
  }
}

function parseDfLine(line: string): DiskRow | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 7) return null;
  const [source, fstype, sizeStr, usedStr, availStr, , mount] = cols;
  const totalBytes = Number(sizeStr);
  const usedBytes = Number(usedStr);
  const availBytes = Number(availStr);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    source,
    fstype,
    mount,
    totalBytes,
    usedBytes,
    availBytes,
    usePct: Math.round((usedBytes / totalBytes) * 100),
  };
}

async function tryStatfsFallback(): Promise<DiskRow[]> {
  const paths = ["/", "/data", "/tmp"];
  const rows: DiskRow[] = [];
  for (const p of paths) {
    try {
      const s = await statfs(p);
      const totalBytes = Number(s.blocks) * s.bsize;
      const availBytes = Number(s.bavail) * s.bsize;
      const usedBytes = totalBytes - Number(s.bfree) * s.bsize;
      if (totalBytes <= 0) continue;
      rows.push({
        source: p,
        fstype: "—",
        mount: p,
        totalBytes,
        usedBytes,
        availBytes,
        usePct: Math.round((usedBytes / totalBytes) * 100),
      });
    } catch {
      // skip — path not visible to this process
    }
  }
  return rows;
}
