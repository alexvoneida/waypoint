import type { EntryStats } from "@/lib/entries";
import { formatDistance, formatDuration, formatElevation } from "./format";

interface Stat {
  label: string;
  value: string;
}

// ascent_m and moving_s are null for GPX-sourced activities by design (see
// activities.ascent_m in db/migrations/0002_schema.sql) - a positive-delta
// sum over track elevation overstates gain, so nothing here derives a
// replacement. Elevation gain simply drops off the bar when it is missing.
// Time falls back from moving_s to elapsed_s rather than disappearing too:
// elapsed_s is never null, and unlike ascent it is not a computed estimate -
// it is a second real measurement of the same hike, just the wall-clock one
// instead of Strava's moving-time one.
function buildStats(stats: EntryStats): Stat[] {
  const entries: Stat[] = [{ label: "Distance", value: formatDistance(stats.distanceM) }];
  if (stats.ascentM != null) {
    entries.push({ label: "Elevation gain", value: formatElevation(stats.ascentM) });
  }
  if (stats.movingS != null) {
    entries.push({ label: "Moving time", value: formatDuration(stats.movingS) });
  } else {
    entries.push({ label: "Time", value: formatDuration(stats.elapsedS) });
  }
  return entries;
}

export function StatisticsBar({ stats }: { stats: EntryStats }) {
  const items = buildStats(stats);
  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-4">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {item.label}
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
