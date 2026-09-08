import Link from "next/link";
import { getViewerFromCookies } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { loadConnectionSummary } from "@/lib/strava/summary";
import { SignInForm } from "./sign-in-form";
import { StravaPanel } from "./strava-panel";

// Session-gated and per-request. Nothing on this page may be cached: it
// renders one account's private state, and a shared cache entry here would be
// the most direct privacy bug available.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Studio",
  robots: { index: false, follow: false },
};

export default async function StudioPage() {
  const userId = await getViewerFromCookies();

  if (!userId) {
    return (
      <Shell>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Sign in to import activities and prepare entries.
        </p>
        <div className="mt-8">
          <SignInForm />
        </div>
      </Shell>
    );
  }

  const [account, connection] = await Promise.all([
    withUser(userId, async (client) => {
      const { rows } = await client.query<{
        display_name: string;
        handle: string;
        drafts: string;
      }>(
        `select u.display_name, u.handle,
                (select count(*) from entries e
                 where e.user_id = u.id and e.status = 'draft') as drafts
         from users u where u.id = $1`,
        [userId],
      );
      return rows[0] ?? null;
    }),
    loadConnectionSummary(userId),
  ]);

  const drafts = Number(account?.drafts ?? 0);

  return (
    <Shell>
      <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
        Signed in as {account?.display_name ?? "your account"}
        {account ? ` (@${account.handle})` : ""}. {drafts} draft
        {drafts === 1 ? "" : "s"} waiting.
      </p>

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Strava
        </h2>
        <div className="mt-4">
          <StravaPanel connection={connection} />
        </div>
        {connection ? (
          <Link
            href="/studio/strava"
            className="mt-4 inline-block text-sm font-medium text-zinc-900 underline underline-offset-4 dark:text-zinc-50"
          >
            Choose activities to import
          </Link>
        ) : null}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Studio
      </h1>
      {children}
    </div>
  );
}
