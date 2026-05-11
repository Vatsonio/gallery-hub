import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { s3Client, BUCKET } from "@/lib/minio";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";

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
  } catch {
    return "fail";
  }
}

export async function GET(): Promise<NextResponse> {
  const [db, minio] = await Promise.all([dbStatus(), minioStatus()]);
  const healthy = db === "ok" && minio === "ok";
  return NextResponse.json({ db, minio }, { status: healthy ? 200 : 503 });
}
