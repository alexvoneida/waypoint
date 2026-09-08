import Link from "next/link";
import { getViewerFromCookies } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { StudioShell } from "../shell";

// Session-gated and per-request, for the same reason /studio is: this page
// renders one account's private state, and a shared cache entry here is the
// most direct privacy bug available.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outings",
  robots: { index: false, follow: false },
};

interface EntryRow {
  id: string;
  title: string;
  slug: string | null;
  status: "draft" | "published";
  visibility: "public" | "private";
  occurred_on: string;
  photo_count: string;
  handle: string;
}

export default async function StudioEntriesPage() {
  const userId = await getViewerFromCookies();

  if (!userId) {
    return (
      <StudioShell current="/studio/entries">
        <p className="mt-8 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <Link href="/studio" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          to see your outings.
        </p>
      </StudioShell>
    );
  }

  const entries = await withUser(userId, async (client) => {
    const { rows } = await client.query<EntryRow>(
      `select e.id, e.title, e.slug, e.status, e.visibility, e.occurred_on::text as occurred_on,
              (select count(*) from photos ph where ph.entry_id = e.id) as photo_count,
              u.handle
       from entries e
       join users u on u.id = e.user_id
       where e.user_id = $1
       order by e.occurred_on desc, e.created_at desc`,
      [userId],
    );
    return rows;
  });

  return (
    <StudioShell current="/studio/entries">
      <section className="mt-8">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">Outings</h2>

        {entries.length === 0 ? (
          <p className="mt-4 max-w-md text-base leading-7 text-zinc-600 dark:text-zinc-400">
            No outings yet. Imported Strava activities appear here as drafts.{" "}
            <Link href="/studio/strava" className="underline underline-offset-4">
              Import an activity
            </Link>{" "}
            to get started.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <Link
                    href={`/studio/entries/${entry.id}`}
                    className="font-medium text-zinc-900 underline underline-offset-4 dark:text-zinc-50"
                  >
                    {entry.title}
                  </Link>
                  <div className="text-figures mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                    <span>{formatOccurredOn(entry.occurred_on)}</span>
                    <span>&middot;</span>
                    <span>
                      {entry.photo_count} photo{entry.photo_count === "1" ? "" : "s"}
                    </span>
                    <Badge>{entry.status}</Badge>
                    {entry.status === "published" ? <Badge>{entry.visibility}</Badge> : null}
                  </div>
                </div>
                {entry.status === "published" && entry.slug ? (
                  <Link
                    href={`/e/${entry.handle}/${entry.slug}`}
                    className="text-sm text-zinc-500 underline underline-offset-4 dark:text-zinc-400"
                  >
                    View public page
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </StudioShell>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </span>
  );
}

function formatOccurredOn(occurredOn: string): string {
  return new Date(`${occurredOn}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
