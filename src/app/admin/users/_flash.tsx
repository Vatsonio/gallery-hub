"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";

export function FlashToasts(): null {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const fired = useRef<string | null>(null);

  useEffect(() => {
    const ok = sp.get("ok");
    const err = sp.get("error");
    const key = `${pathname}?${sp.toString()}`;
    if (!ok && !err) return;
    if (fired.current === key) return;
    fired.current = key;

    if (ok) toast.success(ok);
    if (err) toast.error(err);

    const next = new URLSearchParams(sp.toString());
    next.delete("ok");
    next.delete("error");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, pathname, router, toast]);

  return null;
}
