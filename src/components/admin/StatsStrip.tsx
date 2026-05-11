import { Camera, Eye, Heart, Download } from "lucide-react";

interface Props {
  photos: number;
  views: number;
  favorites: number;
  downloads: number;
}

function Card({ label, value, accent, Icon }: { label: string; value: number; accent?: boolean; Icon: typeof Camera }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-zinc-900 p-4 ring-1 ring-white/5">
      <div className={`rounded-md p-2 ${accent ? "bg-rose-500/15 text-rose-300" : "bg-zinc-800 text-zinc-400"}`}>
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p className={`text-xl font-light ${accent ? "text-rose-300" : "text-white"}`}>{value}</p>
      </div>
    </div>
  );
}

export function StatsStrip({ photos, views, favorites, downloads }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card label="Photos" value={photos} Icon={Camera} />
      <Card label="Views" value={views} Icon={Eye} />
      <Card label="Favorites" value={favorites} accent Icon={Heart} />
      <Card label="Downloads" value={downloads} Icon={Download} />
    </div>
  );
}
