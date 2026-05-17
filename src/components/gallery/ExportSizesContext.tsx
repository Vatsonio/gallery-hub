"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ExportSizes } from "@/lib/exportSizes";

interface ExportSizesValue {
  sizes: ExportSizes;
  setSizes: (next: ExportSizes) => void;
}

const Ctx = createContext<ExportSizesValue | null>(null);

export function useExportSizes(): ExportSizes {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useExportSizes must be used inside <ExportSizesProvider> — wrap the share-route tree",
    );
  }
  return v.sizes;
}

/**
 * Companion hook returning just the setter — used by the ViewerLayer
 * client component when it lands the per-viewer numbers from the API.
 */
export function useExportSizesActions(): { setSizes: (next: ExportSizes) => void } {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useExportSizesActions must be used inside <ExportSizesProvider>",
    );
  }
  return { setSizes: v.setSizes };
}

interface ProviderProps {
  initial: ExportSizes;
  children: React.ReactNode;
}

/**
 * Holds the byte-totals + counts used by the export modal. Seeded by the
 * static shell (with viewer-specific bits zeroed) and updated by the
 * PPR dynamic island via ExportSizesHydration the moment the viewer
 * favorites query lands.
 */
export function ExportSizesProvider({ initial, children }: ProviderProps): React.ReactNode {
  const [sizes, setSizes] = useState<ExportSizes>(initial);
  useEffect(() => {
    setSizes(initial);
  }, [initial]);
  return (
    <Ctx.Provider value={{ sizes, setSizes }}>{children}</Ctx.Provider>
  );
}

/**
 * Tiny client shim that swaps the modal's per-viewer numbers in after the
 * dynamic island resolves. The provider's setter is stable, so this never
 * loops; it fires exactly once per island-stream.
 */
export function ExportSizesHydration({ sizes }: { sizes: ExportSizes }): null {
  const v = useContext(Ctx);
  useEffect(() => {
    if (!v) return;
    v.setSizes(sizes);
  }, [v, sizes]);
  return null;
}
