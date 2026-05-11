import { cookies } from "next/headers";
import { getIronSession, type SessionOptions, type IronSession } from "iron-session";

export interface AdminSession {
  userId?: string;
  email?: string;
}

export const sessionOptions: SessionOptions = {
  password:
    process.env.SESSION_PASSWORD ??
    "dev-only-insecure-password-please-override-in-production-env",
  cookieName: "gh_admin_session",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30
  }
};

export async function getAdminSession(): Promise<IronSession<AdminSession>> {
  const cookieStore = await cookies();
  return getIronSession<AdminSession>(cookieStore, sessionOptions);
}
