/**
 * Helpers for "real e2e" tests under `tests/e2e-real/`.
 *
 * The integration suite shares one MinIO via globalSetup, but those tests mock
 * imgproxy. The bug fixed in 94c651d (cache-bust appended to S3 source URL →
 * MinIO 400) slipped past every layer because nobody joined imgproxy + MinIO
 * with real bytes. The helpers here spin a self-contained pair of containers
 * on a user-defined network so an imgproxy GET actually fetches an upstream
 * S3 object, and the test sees the resized response body.
 *
 * Container pair lifetime is *per-suite* — call `startImgproxyMinio()` in
 * beforeAll and `stop()` in afterAll. We don't reuse the global MinIO because
 * imgproxy needs to talk to it over a Docker network alias (it can't reach
 * the host-mapped port reliably across runtimes), and the global container
 * has no alias.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  GenericContainer,
  Network,
  StartedNetwork,
  StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ImgproxyMinioPair {
  /** Public base URL to issue HTTP GETs against (e.g. http://127.0.0.1:32811). */
  imgproxyBaseUrl: string;
  /** S3 client wired up to the MinIO mapped port — for uploading test fixtures. */
  s3: S3Client;
  /** Name of the bucket the imgproxy container is configured to read from. */
  bucket: string;
  /** 32-hex signing key — also exported via env to the URL builder. */
  imgproxyKeyHex: string;
  /** 32-hex signing salt — ditto. */
  imgproxySaltHex: string;
  /** Stop and clean up both containers + the user-defined network. */
  stop(): Promise<void>;
}

const MINIO_ALIAS = "gh-test-minio";
const MINIO_USER = "minio";
const MINIO_PASS = "minio12345";
const BUCKET = "gallery-imgproxy-e2e";

/**
 * Boot a MinIO + imgproxy pair on a fresh Docker network, create the test
 * bucket, and return handles for upload + URL building.
 *
 * Cold-start cost: ~5–10s. We pin imgproxy to a known good tag (v3) so a
 * latest-tag drift doesn't break the suite silently.
 */
export async function startImgproxyMinio(): Promise<ImgproxyMinioPair> {
  // Deterministic per-run secrets so the URL builder + imgproxy verifier
  // produce identical signatures. 32 hex chars = 16 bytes = imgproxy's
  // recommended minimum.
  const imgproxyKeyHex = randomBytes(32).toString("hex");
  const imgproxySaltHex = randomBytes(32).toString("hex");

  const network: StartedNetwork = await new Network().start();

  const minio: StartedTestContainer = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_USER,
      MINIO_ROOT_PASSWORD: MINIO_PASS,
    })
    .withExposedPorts(9000)
    .withNetwork(network)
    .withNetworkAliases(MINIO_ALIAS)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .withStartupTimeout(60_000)
    .start();

  const minioHost = minio.getHost();
  const minioPort = minio.getMappedPort(9000);
  const minioPublicEndpoint = `http://${minioHost}:${minioPort}`;

  const s3 = new S3Client({
    endpoint: minioPublicEndpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASS },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

  const imgproxy: StartedTestContainer = await new GenericContainer(
    "ghcr.io/imgproxy/imgproxy:v3",
  )
    .withEnvironment({
      IMGPROXY_KEY: imgproxyKeyHex,
      IMGPROXY_SALT: imgproxySaltHex,
      IMGPROXY_USE_S3: "true",
      // Internal Docker hostname — only reachable from inside the network.
      IMGPROXY_S3_ENDPOINT: `http://${MINIO_ALIAS}:9000`,
      IMGPROXY_S3_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: MINIO_USER,
      AWS_SECRET_ACCESS_KEY: MINIO_PASS,
      // MinIO inside Docker advertises a non-routable address on its
      // GetObject signed URLs; loopback-source must be allowed for
      // imgproxy to fetch from it (matches docker-compose.yml).
      IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES: "true",
      IMGPROXY_ENFORCE_WEBP: "true",
      IMGPROXY_ENFORCE_AVIF: "false",
      IMGPROXY_QUALITY: "82",
      IMGPROXY_AVIF_SPEED: "8",
      IMGPROXY_TTL: "31536000",
      IMGPROXY_USE_ETAG: "true",
    })
    .withExposedPorts(8080)
    .withNetwork(network)
    .withWaitStrategy(Wait.forHttp("/health", 8080))
    .withStartupTimeout(60_000)
    .start();

  const imgproxyBaseUrl = `http://${imgproxy.getHost()}:${imgproxy.getMappedPort(8080)}`;

  async function stop(): Promise<void> {
    try {
      await imgproxy.stop();
    } catch {
      // swallow — best-effort cleanup
    }
    try {
      await minio.stop();
    } catch {
      // swallow
    }
    try {
      await network.stop();
    } catch {
      // swallow
    }
  }

  return {
    imgproxyBaseUrl,
    s3,
    bucket: BUCKET,
    imgproxyKeyHex,
    imgproxySaltHex,
    stop,
  };
}

/** Upload bytes at `key` under the test bucket with a sensible content type. */
export async function putObject(
  pair: ImgproxyMinioPair,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await pair.s3.send(
    new PutObjectCommand({
      Bucket: pair.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Fetch a URL and return the body bytes + headers. Wraps node fetch with
 * a longer timeout because the first imgproxy hit cold-decodes the source. */
export async function fetchImage(
  url: string,
  accept: string,
): Promise<{ status: number; contentType: string; body: Buffer; etag: string | null }> {
  const res = await fetch(url, {
    headers: { Accept: accept },
    // Buffer the whole response; tests inspect bytes.
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body,
    etag: res.headers.get("etag"),
  };
}

/** Stable SHA-256 of a buffer for cross-format equality checks. */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
