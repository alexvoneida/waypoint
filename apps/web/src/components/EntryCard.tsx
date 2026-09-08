import Link from "next/link";
import type { DiscoveryEntry } from "@/lib/entries";
import { BlurredImage } from "./BlurredImage";
import { RouteThumbnail } from "./RouteThumbnail";
import { buildStats } from "./StatisticsBar";

const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 427;

function formatOccurredOn(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// The one card used by both the discovery grid and a profile's outings
// list, so the two surfaces never drift out of sync on what a "hike" shows.
export function EntryCard({
  entry,
  showAuthor,
  priority = false,
}: {
  entry: DiscoveryEntry;
  showAuthor: boolean;
  // The first card above the fold on a grid is that page's LCP candidate.
  priority?: boolean;
}) {
  const stats = buildStats(entry.stats);

  return (
    <Link href={`/e/${entry.handle}/${entry.slug}`} className="group block">
      {entry.leadPhoto ? (
        <BlurredImage
          src={`/i/${entry.leadPhoto.id}/web`}
          blurHash={entry.leadPhoto.blurHash}
          width={entry.leadPhoto.width ?? FALLBACK_WIDTH}
          height={entry.leadPhoto.height ?? FALLBACK_HEIGHT}
          alt=""
          className="rounded-sm"
          priority={priority}
        />
      ) : (
        <div className="aspect-[3/2] rounded-sm bg-zinc-100 dark:bg-zinc-900" />
      )}

      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        {formatOccurredOn(entry.occurredOn)}
        {showAuthor && <> · @{entry.handle}</>}
      </p>

      <h2 className="mt-1 text-lg font-medium text-zinc-900 group-hover:text-[var(--accent)] dark:text-zinc-50">
        {entry.title}
      </h2>
      {entry.trailName && (
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{entry.trailName}</p>
      )}

      <div className="mt-3 flex items-end justify-between gap-3">
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {stats.map((stat) => (
            <div key={stat.label} className="flex items-baseline gap-1">
              <dd className="text-sm font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
                {stat.value}
              </dd>
              <dt className="text-xs text-zinc-400 dark:text-zinc-500">{stat.label}</dt>
            </div>
          ))}
        </dl>
        <RouteThumbnail geojson={entry.trackGeojson} />
      </div>

      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        {entry.likeCount} {entry.likeCount === 1 ? "like" : "likes"}
      </p>
    </Link>
  );
}
