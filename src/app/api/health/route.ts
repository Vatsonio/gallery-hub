import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { s3Client, BUCKET } from "@/lib/minio";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";

// Process start time captured at module load. Used to surface uptime_s for
// uptime monitors (Cloudflare healthcheck, Portainer, external probes).
const PROCESS_STARTED_AT_MS: number = Date.now();

async function dbStatus(): Promise<"ok" | "fail"> {
  try {
    await sql`SELECT 1`;
    return "ok";
  } catch {
    return "fail";
  }
}

async function minioStatus(): Promise<"ok" | "fail"> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return "ok";
  } catch (err: unknown) {
    // 404 = MinIO answered, just no bucket yet. The bucket is created on
    // first upload via ensureBucket(); treating "missing" as a fail would
    // stall the container as unhealthy on a fresh deploy before any user
    // has logged in.
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      return "ok";
    }
    return "fail";
  }
}

export interface HealthResponse {
  db: "ok" | "fail";
  minio: "ok" | "fail";
  uptime_s: number;
  version: string;
}

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const [db, minio] = await Promise.all([dbStatus(), minioStatus()]);
  const healthy = db === "ok" && minio === "ok";
  const uptime_s = Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000);
  const version = process.env.APP_VERSION ?? "dev";
  return NextResponse.json<HealthResponse>(
    { db, minio, uptime_s, version },
    { status: healthy ? 200 : 503 }
  );
}
