export interface JustifiedInput {
  photos: { id: string; width: number; height: number }[];
  containerWidth: number;
  targetRowHeight: number;
  gap: number;
  maxLastRowScale: number;
}

export interface JustifiedItem { id: string; width: number; height: number }
export interface JustifiedRow { height: number; items: JustifiedItem[] }

export function layoutJustifiedRows(input: JustifiedInput): JustifiedRow[] {
  const { photos, containerWidth, targetRowHeight, gap, maxLastRowScale } = input;
  if (photos.length === 0) return [];

  const rows: JustifiedRow[] = [];
  let current: typeof photos = [];
  let currentRatioSum = 0;

  const ratio = (p: { width: number; height: number }) => p.width / p.height;
  const widthAtHeight = (p: { width: number; height: number }, h: number) => ratio(p) * h;

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const tentative = [...current, p];
    const tentativeRatioSum = currentRatioSum + ratio(p);
    const tentativeWidth = tentativeRatioSum * targetRowHeight + gap * (tentative.length - 1);

    if (tentativeWidth >= containerWidth && current.length > 0) {
      const currentWidth = currentRatioSum * targetRowHeight + gap * Math.max(0, current.length - 1);
      const includeNew = Math.abs(tentativeWidth - containerWidth) <= Math.abs(containerWidth - currentWidth);
      const rowPhotos = includeNew ? tentative : current;
      const rowRatioSum = includeNew ? tentativeRatioSum : currentRatioSum;
      const availableWidth = containerWidth - gap * (rowPhotos.length - 1);
      const rowHeight = availableWidth / rowRatioSum;
      rows.push({
        height: rowHeight,
        items: rowPhotos.map(rp => ({ id: rp.id, width: widthAtHeight(rp, rowHeight), height: rowHeight })),
      });
      if (includeNew) {
        current = [];
        currentRatioSum = 0;
      } else {
        current = [p];
        currentRatioSum = ratio(p);
      }
    } else {
      current = tentative;
      currentRatioSum = tentativeRatioSum;
    }
  }

  if (current.length > 0) {
    let rowHeight = targetRowHeight;
    const naturalWidth = currentRatioSum * rowHeight + gap * (current.length - 1);
    if (naturalWidth < containerWidth) {
      const availableWidth = containerWidth - gap * (current.length - 1);
      const fillHeight = availableWidth / currentRatioSum;
      rowHeight = Math.min(fillHeight, targetRowHeight * maxLastRowScale);
    } else {
      const availableWidth = containerWidth - gap * (current.length - 1);
      rowHeight = availableWidth / currentRatioSum;
    }
    rows.push({
      height: rowHeight,
      items: current.map(rp => ({ id: rp.id, width: widthAtHeight(rp, rowHeight), height: rowHeight })),
    });
  }

  return rows;
}
