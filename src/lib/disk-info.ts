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

async function tryDf(): Promise<DiskRow[]> {
  try {
    const { stdout } = await execAsync(
      // -P: POSIX one-line-per-fs · -B1: bytes · -T: include fstype
      // -x: skip pseudo / virtual / overlay-tmpfs-ish entries that
      // pollute the table with 0-byte rows.
      "df -PT -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x proc -x sysfs",
      { timeout: 5_000 },
    );
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return [];
    return lines.slice(1).map(parseDfLine).filter((r): r is DiskRow => r !== null);
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
