"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ConnectionSummary {
  athleteId: string;
  backfillStatus: "none" | "listing" | "ready" | "importing" | "done";
  rateLimitedUntil: string | null;
  listingError: string | null;
  listedCount: number;
  importedCount: number;
}

interface Props {
  connection: ConnectionSummary | null;
}

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export function StravaPanel({ connection }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"disconnect" | "rescan" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function post(path: string, action: "disconnect" | "rescan") {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        revokedAtStrava?: boolean;
      } | null;

      if (!response.ok) {
        setMessage(payload?.error ?? "Something went wrong. Try again.");
        return;
      }
      if (action === "disconnect" && payload?.revokedAtStrava === false) {
        // The local tokens are gone either way; what is left is a grant only
        // Strava can remove, and saying so is more useful than a bare "done".
        setMessage(
          "Disconnected here, but Strava did not confirm the revocation. Remove Waypoint under Settings → My Apps at strava.com to be certain.",
        );
      }
      router.refresh();
    } catch {
      setMessage("Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!connection) {
    return (
      <div className="space-y-3">
        <p className="text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Connect Strava to import your past activities as drafts. Waypoint asks
          for read access to your activities and nothing else, and you can
          disconnect at any time.
        </p>
        {/* A form, not next/link: the endpoint answers with a redirect to
            strava.com, and a client-side navigation cannot follow one off
            this origin. A plain document GET is what the OAuth flow needs. */}
        <form action="/api/strava/authorize" method="get">
          <button
            type="submit"
            className="rounded-md bg-[#fc4c02] px-4 py-2 text-base font-medium text-white transition-opacity hover:opacity-90"
          >
            Connect with Strava
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Athlete</dt>
          <dd className="text-zinc-900 dark:text-zinc-50">{connection.athleteId}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Activities listed</dt>
          <dd className="text-zinc-900 dark:text-zinc-50">{connection.listedCount}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Imported</dt>
          <dd className="text-zinc-900 dark:text-zinc-50">{connection.importedCount}</dd>
        </div>
      </dl>

      <BackfillState connection={connection} />

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null}
          onClick={() => post("/api/strava/backfill", "rescan")}
        >
          {busy === "rescan" ? "Starting..." : "Rescan activities"}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null}
          onClick={() => post("/api/strava/disconnect", "disconnect")}
        >
          {busy === "disconnect" ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>

      {message ? (
        <p className="text-sm text-amber-700 dark:text-amber-500" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * N-3's visible degradation. A rate limit is reported as a pause with a time,
 * never as a failure and never as silence -- the scan resumes on its own, and
 * the only wrong thing to show here is a list that stopped growing for no
 * stated reason.
 */
function BackfillState({ connection }: { connection: ConnectionSummary }) {
  if (connection.rateLimitedUntil) {
    const resumesAt = new Date(connection.rateLimitedUntil);
    return (
      <p className="text-sm text-amber-700 dark:text-amber-500">
        Strava&apos;s rate limit was reached, so the scan is paused. It resumes at{" "}
        {resumesAt.toLocaleTimeString()}; activities already listed can be imported now.
      </p>
    );
  }
  if (connection.listingError) {
    return <p className="text-sm text-red-600 dark:text-red-400">{connection.listingError}</p>;
  }
  if (connection.backfillStatus === "listing") {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Listing your activities from Strava. The list grows as pages arrive.
      </p>
    );
  }
  if (connection.backfillStatus === "importing") {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Importing. Each activity becomes a draft once its track arrives.
      </p>
    );
  }
  return null;
}
