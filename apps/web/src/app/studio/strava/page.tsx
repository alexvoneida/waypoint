import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewerFromCookies } from "@/lib/auth";
import { loadConnectionSummary } from "@/lib/strava/summary";
import { StravaPanel } from "../strava-panel";
import { ActivitySelector } from "./activity-selector";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Import from Strava",
  robots: { index: false, follow: false },
};

// The callback's failure codes, turned into something a person can act on.
// Strava's own message never reaches the browser: it can name the
// application's client_id, and it is written for a developer reading a log.
const CALLBACK_ERRORS: Record<string, string> = {
  denied: "Strava did not grant access. You can try connecting again.",
  incomplete: "Strava's response was missing something. Try connecting again.",
  state:
    "That authorization link had expired or had already been used. Start the connection again from this page.",
  exchange: "Strava could not complete the connection. Try again in a moment.",
  scope:
    "Waypoint needs permission to read your activities. Connect again and leave that permission checked.",
};

export default async function StravaImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await getViewerFromCookies();
  if (!userId) {
    redirect("/studio");
  }

  const [connection, params] = await Promise.all([loadConnectionSummary(userId), searchParams]);
  const callbackError = params.error ? CALLBACK_ERRORS[params.error] : null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-16 sm:px-8">
      <Link
        href="/studio"
        className="text-sm text-zinc-500 underline underline-offset-4 dark:text-zinc-400"
      >
        Studio
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Import from Strava
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
        Each activity you choose becomes a draft entry with its track attached and no
        photographs yet. Upload the photographs against the draft, and correlation places
        them on the track.
      </p>

      {callbackError ? (
        <p className="mt-6 text-sm text-red-600 dark:text-red-400">{callbackError}</p>
      ) : null}

      <div className="mt-10">
        <StravaPanel connection={connection} />
      </div>

      {connection ? (
        <div className="mt-12">
          <ActivitySelector />
        </div>
      ) : null}
    </div>
  );
}
