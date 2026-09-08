import { loadDiscoveryEntries } from "@/lib/entries";
import { EntryCard } from "@/components/EntryCard";

const DISCOVERY_ENTRY_LIMIT = 24;

// Purely reverse-chronological - no ranking, no algorithm. That is a stated
// product decision, not a placeholder for one: every visitor sees the same
// feed, in the order things were published.
export const revalidate = 300;

export default async function Home() {
  const entries = await loadDiscoveryEntries(DISCOVERY_ENTRY_LIMIT);

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
        <ul className="mt-12 grid grid-cols-1 gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry, index) => (
            <li key={`${entry.handle}/${entry.slug}`}>
              <EntryCard entry={entry} showAuthor priority={index === 0} />
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
