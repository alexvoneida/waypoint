import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadTrailPage } from "@/lib/trail-page";
import { TrailMapClient } from "@/components/TrailMapClient";
import { SeasonStrip } from "@/components/SeasonStrip";
import { TrailVisitCard } from "@/components/TrailVisitCard";

// Same ISR shape as the entry page: nothing built at `next build` time, every
// trail renders on its first visit and stays cached for an hour. Publishing
// an entry onto a trail revalidates this path directly, so a new visit does
// not have to wait out the hour either.
export const revalidate = 3600;

export async function generateStaticParams() {
  return [];
}

// generateMetadata and the page component both need the same trail; cache()
// scopes the memoization to one request, matching the entry page's getEntry.
const getTrail = cache(async (slug: string) => loadTrailPage(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const trail = await getTrail(slug);
  if (!trail) return {};
  return {
    title: `${trail.name} — Waypoint`,
    description: `${trail.visitCount} ${trail.visitCount === 1 ? "visit" : "visits"} to ${trail.name} on Waypoint.`,
  };
}

// Duplicated from the entry page rather than shared: both format a bare SQL
// date the same way, but it is a three-line function and the two pages have
// no other reason to import from each other (the same call trail-match.ts
// makes about its own duplicated slugify()).
function formatOccurredOn(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function TrailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const trail = await getTrail(slug);
  // A trail row with no visible visits is still a real trail (see
  // loadTrailPage), so this miss means the slug itself does not exist.
  if (!trail) notFound();

  const hasVisits = trail.groups.length > 0;
  const allTracks = trail.groups.flatMap((group) => group.visits.map((visit) => visit.trackGeojson));

  return (
    <article className="mx-auto max-w-5xl px-6 py-12 sm:px-8 sm:py-16">
      <header className="mb-12 sm:mb-16">
        <h1 className="text-entry-title text-zinc-900 dark:text-zinc-50">{trail.name}</h1>
        {trail.nameSource === "osm" && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Name via OpenStreetMap contributors, ODbL-licensed.
          </p>
        )}
        <p className="text-figures mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          {hasVisits
            ? `${trail.visitCount} ${trail.visitCount === 1 ? "visit" : "visits"} recorded here`
            : "No one has published a visit to this trail yet."}
        </p>

        {hasVisits && (
          <div className="mt-6">
            <SeasonStrip months={trail.monthsRepresented} />
          </div>
        )}
      </header>

      {hasVisits && (
        <>
          <div className="mb-14">
            <TrailMapClient tracks={allTracks} />
          </div>

          <div className="flex flex-col gap-14">
            {trail.groups.map((group, groupIndex) => (
              <section key={group.occurredOn}>
                <h2 className="text-figures text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {formatOccurredOn(group.occurredOn)}
                </h2>
                <ul className="mt-5 grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                  {group.visits.map((visit, visitIndex) => (
                    <TrailVisitCard
                      key={`${visit.authorHandle}/${visit.entrySlug}`}
                      visit={visit}
                      priority={groupIndex === 0 && visitIndex === 0}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </article>
  );
}
