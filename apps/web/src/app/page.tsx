import Link from "next/link";
import { loadRecentEntries } from "@/lib/entries";
import { BlurredImage } from "@/components/BlurredImage";
import { formatDistance } from "@/components/format";

const RECENT_ENTRY_LIMIT = 12;
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 427;

export const revalidate = 300;

export default async function Home() {
  const entries = await loadRecentEntries(RECENT_ENTRY_LIMIT);

  return (
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8">
      <header className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Waypoint
        </h1>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          A dedicated camera records the best photographs of a hike and the
          worst metadata about it. Waypoint correlates each photograph&apos;s
          capture time against a GPS track from the same hike, so every frame
          lands where it was actually taken.
        </p>
      </header>

      {entries.length > 0 ? (
        <ul className="mt-12 grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <li key={`${entry.handle}/${entry.slug}`}>
              <Link href={`/e/${entry.handle}/${entry.slug}`} className="group block">
                {entry.leadPhoto ? (
                  <BlurredImage
                    src={`/i/${entry.leadPhoto.id}/web`}
                    blurHash={entry.leadPhoto.blurHash}
                    width={entry.leadPhoto.width ?? FALLBACK_WIDTH}
                    height={entry.leadPhoto.height ?? FALLBACK_HEIGHT}
                    alt=""
                    className="rounded-sm"
                  />
                ) : (
                  <div className="aspect-[3/2] rounded-sm bg-zinc-100 dark:bg-zinc-900" />
                )}
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                  {entry.authorDisplayName} · {formatDistance(entry.distanceM)}
                </p>
                <h2 className="mt-1 text-lg font-medium text-zinc-900 group-hover:text-[var(--accent)] dark:text-zinc-50">
                  {entry.title}
                </h2>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-12 text-base text-zinc-500 dark:text-zinc-400">
          No entries have been published yet.
        </p>
      )}
    </div>
  );
}
