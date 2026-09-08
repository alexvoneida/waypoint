import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadEntryPage } from "@/lib/entries";
import { EntryExperience } from "@/components/EntryExperience";
import { EntrySocial } from "@/components/EntrySocial";
import { StatisticsBar } from "@/components/StatisticsBar";

// No paths built at `next build` time (the database is not assumed reachable
// during a build) - every entry is rendered on its first visit and cached
// for an hour after that. The write side calls revalidatePath on publish, so
// an edit does not have to wait out the hour to appear.
export const revalidate = 3600;

export async function generateStaticParams() {
  return [];
}

// generateMetadata and the page component both need the same entry; cache()
// scopes the memoization to one request so the second call is free instead of
// a second round trip to Postgres.
const getEntry = cache(async (handle: string, slug: string) => {
  // Deliberately viewer-independent. This page is statically generated and
  // revalidated on publish, and a page that reads the request's cookies cannot
  // be: Next refuses to prerender it, which is the right refusal - a cached
  // personalised render is one viewer's page served to the next visitor.
  //
  // The cost is that the owner of a private account gets a 404 at their own
  // public URL rather than a preview; that belongs in the studio, which is
  // where an unpublished or hidden outing is managed from.
  return loadEntryPage(handle, slug, null);
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}): Promise<Metadata> {
  const { handle, slug } = await params;
  const entry = await getEntry(handle, slug);
  if (!entry) return {};
  return {
    title: `${entry.title} — Waypoint`,
    description: entry.notes ?? `A hike recorded by ${entry.authorDisplayName} on Waypoint.`,
  };
}

function formatOccurredOn(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function EntryPage({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}) {
  const { handle, slug } = await params;
  const entry = await getEntry(handle, slug);
  // A miss here means "no such published entry, and you are not its owner" -
  // visible_entries and the owner fallback in loadEntryPage are the only two
  // ways in, so there is nothing left to distinguish with a 403.
  if (!entry) notFound();

  return (
    <article className="mx-auto max-w-5xl px-6 py-12 sm:px-8 sm:py-16">
      <header className="mb-12 sm:mb-16">
        <p className="text-figures text-sm text-zinc-500 dark:text-zinc-400">
          {formatOccurredOn(entry.occurredOn)} · {entry.authorDisplayName}
        </p>
        <h1 className="text-entry-title mt-2 text-zinc-900 dark:text-zinc-50">{entry.title}</h1>
        {entry.notes && (
          <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            {entry.notes}
          </p>
        )}
        <div className="mt-8">
          <StatisticsBar stats={entry.stats} />
        </div>
      </header>

      <EntryExperience
        trackGeojson={entry.trackGeojson}
        elevation={entry.elevation}
        photos={entry.photos}
      />

      <section className="mt-16 max-w-2xl sm:mt-20">
        <EntrySocial entryId={entry.id} />
      </section>
    </article>
  );
}
