import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default function PublicShareLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#0a0a0a] text-white antialiased">{children}</div>;
}
