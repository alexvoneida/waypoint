import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getViewerFromCookies } from "@/lib/auth";
import { loadProfilePage } from "@/lib/entries";
import { EntryCard } from "@/components/EntryCard";

// A profile lives at `/@handle`. The App Router treats a folder literally
// named `@handle` as a parallel-route slot (a convention for rendering
// alongside a page, not a route of its own), so `app/@handle/page.tsx`
// would compile without error and simply never answer any request - no
// route is registered for it at all.
//
// The fix is to route on a plain dynamic segment, `[handle]`, and carry the
// leading "@" inside the captured value instead of the folder name. Dynamic
// segments match on the literal request path, not on some restricted
// character set, so a request for `/@alexvoneida` lands here with
// `params.handle === "@alexvoneida"`; anything that doesn't start with "@"
// (or is empty) 404s below before it ever reaches a database query, so a
// bare `/[handle]` route doesn't turn into an open plain-username scheme by
// accident. Static top-level routes (`/e`, `/t`, `/signup`, `/api`, ...)
// still win their own paths - the App Router matches static segments before
// dynamic ones, so this only ever catches the paths nothing else claims.
// Not ISR: unlike the entry page, this route's output genuinely differs by
// viewer (the owner of a private account sees their own outings list; every
// other viewer sees the gated state) - reading cookies() to resolve that,
// while also exporting `revalidate` and `generateStaticParams`, is what
// throws DYNAMIC_SERVER_USAGE at request time under `next start` (confirmed
// against this build; see report). It's also the framework refusing to do
// something worse: caching one viewer's personalized render and serving it
// to the next. force-dynamic renders every request fresh, which is the only
// correct option for a page whose content is a function of who's asking.
export const dynamic = "force-dynamic";

// The captured segment shows up percent-encoded ("%40handle") in some
// render passes (generateMetadata) and already decoded ("@handle") in
// others (the page component itself) for the same request - decoding
// unconditionally here makes both forms resolve the same way instead of
// requiring one of the two call sites to guess right.
function parseHandle(routeParam: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(routeParam);
  } catch {
    return null;
  }
  if (!decoded.startsWith("@") || decoded.length < 2) return null;
  return decoded.slice(1);
}

const getProfile = cache(async (routeParam: string) => {
  const handle = parseHandle(routeParam);
  if (!handle) return null;
  const viewerId = await getViewerFromCookies();
  return loadProfilePage(handle, viewerId);
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getProfile(handle);
  if (!profile) return {};
  return {
    title: `${profile.header.displayName} (@${profile.header.handle}) — Waypoint`,
  };
}

function formatJoinedOn(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await getProfile(handle);
  if (!profile) notFound();

  return (
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-20">
      <header className="max-w-2xl">
        <h1 className="text-page-title text-zinc-900 dark:text-zinc-50">
          {profile.header.displayName}
        </h1>
        <p className="text-figures mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          @{profile.header.handle} · joined {formatJoinedOn(profile.header.joinedAt)}
        </p>
      </header>

      {!profile.outingsVisible ? (
        // Deliberately says nothing about how many entries exist behind
        // this - not "0 public entries", just that the list is closed.
        <p className="mt-14 max-w-md text-base leading-7 text-zinc-500 dark:text-zinc-400">
          This account is private. Its owner has chosen not to share their outings publicly.
        </p>
      ) : profile.entries.length > 0 ? (
        <ul className="mt-14 grid grid-cols-1 gap-x-6 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {profile.entries.map((entry) => (
            <li key={entry.slug}>
              <EntryCard entry={entry} showAuthor={false} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-14 max-w-md text-base leading-7 text-zinc-500 dark:text-zinc-400">
          {profile.header.displayName} hasn&apos;t published any outings yet.
        </p>
      )}
    </div>
  );
}
