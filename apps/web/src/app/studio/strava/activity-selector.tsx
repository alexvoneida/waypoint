"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistance, formatDuration, formatElevation } from "@/components/format";

interface ListingRow {
  stravaId: string;
  name: string;
  sportType: string;
  startDate: string;
  timezone: string | null;
  distanceM: number;
  ascentM: number | null;
  movingS: number | null;
  elapsedS: number;
  activityId: string | null;
  importedAt: string | null;
  importError: string | null;
}

interface ListingResponse {
  connection: {
    backfillStatus: "none" | "listing" | "ready" | "importing" | "done";
    rateLimitedUntil: string | null;
    listingError: string | null;
  };
  activities: ListingRow[];
  total: number;
  limit: number;
  offset: number;
  facets: { sportTypes: string[]; years: number[] };
}

const PAGE_SIZE = 25;

// Long enough that nobody watches a spinner tick, short enough that a page of
// imports appears while they are still looking at the list. Only runs while
// work is actually outstanding -- see the effect below.
const POLL_MS = 4000;

interface Loaded {
  data?: ListingResponse;
  error?: string;
}

const CONTROL =
  "rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-50";

export function ActivitySelector() {
  const [data, setData] = useState<ListingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState("");
  const [year, setYear] = useState("");
  const [hideImported, setHideImported] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Fetches and returns; it never writes state itself. Every caller decides
  // whether its answer is still wanted, which is what keeps a slow response
  // for one set of filters from landing on top of a newer one.
  const fetchListing = useCallback(async (): Promise<Loaded> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (sport) params.set("sport", sport);
    if (year) params.set("year", year);
    if (hideImported) params.set("unimported", "true");

    try {
      const response = await fetch(`/api/strava/activities?${params.toString()}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        return { error: payload?.error ?? "The activity list could not be loaded." };
      }
      return { data: (await response.json()) as ListingResponse };
    } catch {
      return { error: "The activity list could not be loaded." };
    }
  }, [offset, sport, year, hideImported]);

  const apply = useCallback((result: Loaded) => {
    if (result.error) {
      setError(result.error);
      return;
    }
    setData(result.data ?? null);
    setError(null);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchListing().then((result) => {
      if (current) apply(result);
    });
    // Filters changing mid-flight abandon the response in flight rather than
    // letting it overwrite the newer one.
    return () => {
      current = false;
    };
  }, [fetchListing, apply]);

  // Polls only while the scan or an import is still running. A finished
  // listing is a static page and should not be re-fetched every four seconds
  // for as long as the tab stays open.
  const busy =
    data?.connection.backfillStatus === "listing" ||
    data?.connection.backfillStatus === "importing";
  useEffect(() => {
    if (!busy) return;
    let current = true;
    const timer = setInterval(() => {
      void fetchListing().then((result) => {
        if (current) apply(result);
      });
    }, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [busy, fetchListing, apply]);

  function toggle(stravaId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(stravaId)) next.add(stravaId);
      return next;
    });
  }

  async function importSelected() {
    if (selected.size === 0) return;
    setImporting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/strava/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stravaIds: [...selected] }),
      });
      const payload = (await response.json().catch(() => null)) as {
        queued?: number;
        error?: string;
      } | null;
      if (!response.ok) {
        setNotice(payload?.error ?? "The import could not be started.");
        return;
      }
      setNotice(
        `${payload?.queued ?? 0} activit${payload?.queued === 1 ? "y" : "ies"} queued. ` +
          "Each becomes a draft once its track arrives.",
      );
      setSelected(new Set());
      apply(await fetchListing());
    } catch {
      setNotice("The import could not be started.");
    } finally {
      setImporting(false);
    }
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading your activities...</p>;
  }

  const selectableOnPage = data.activities.filter((row) => !row.activityId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-600 dark:text-zinc-400">
          Sport{" "}
          <select
            value={sport}
            onChange={(event) => {
              setSport(event.target.value);
              setOffset(0);
            }}
            className={CONTROL}
          >
            <option value="">All</option>
            {data.facets.sportTypes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm text-zinc-600 dark:text-zinc-400">
          Year{" "}
          <select
            value={year}
            onChange={(event) => {
              setYear(event.target.value);
              setOffset(0);
            }}
            className={CONTROL}
          >
            <option value="">All</option>
            {data.facets.years.map((value) => (
              <option key={value} value={String(value)}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={hideImported}
            onChange={(event) => {
              setHideImported(event.target.checked);
              setOffset(0);
            }}
          />
          Hide already imported
        </label>
      </div>

      {data.connection.rateLimitedUntil ? (
        <p className="text-sm text-amber-700 dark:text-amber-500">
          Strava&apos;s rate limit was reached. The scan resumes at{" "}
          {new Date(data.connection.rateLimitedUntil).toLocaleTimeString()}; what is listed
          below can be imported now.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th scope="col" className="w-8 py-2">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Activity
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Date
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Distance
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Ascent
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {data.activities.map((row) => (
              <tr
                key={row.stravaId}
                className="border-b border-zinc-100 align-top dark:border-zinc-900"
              >
                <td className="py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(row.stravaId)}
                    disabled={row.activityId !== null}
                    onChange={() => toggle(row.stravaId)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                <td className="py-3 pr-4">
                  <span className="text-zinc-900 dark:text-zinc-50">{row.name}</span>
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {row.sportType}
                  </span>
                  {row.activityId ? (
                    <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-500">
                      imported
                    </span>
                  ) : null}
                  {row.importError ? (
                    <span className="block text-xs text-red-600 dark:text-red-400">
                      {row.importError}
                    </span>
                  ) : null}
                </td>
                <td className="text-figures py-3 pr-4 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatLocalDate(row)}
                </td>
                <td className="text-figures py-3 pr-4 text-right whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDistance(row.distanceM)}
                </td>
                <td className="text-figures py-3 pr-4 text-right whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {/* An em dash, never a zero: an absent figure is honest and
                      a fabricated one is not (§6). */}
                  {row.ascentM === null ? "—" : formatElevation(row.ascentM)}
                </td>
                <td className="text-figures py-3 text-right whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDuration(row.movingS ?? row.elapsedS)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.activities.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {data.connection.backfillStatus === "listing"
            ? "Still listing your activities from Strava."
            : "No activities match these filters."}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-figures text-sm text-zinc-500 dark:text-zinc-400">
          {data.total === 0
            ? "No activities"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)} of ${data.total}`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={CONTROL}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            type="button"
            className={CONTROL}
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setSelected(new Set(selectableOnPage.map((row) => row.stravaId)))}
          disabled={selectableOnPage.length === 0}
          className="text-sm text-zinc-600 underline underline-offset-4 disabled:opacity-50 dark:text-zinc-400"
        >
          Select all on this page
        </button>
        <button
          type="button"
          onClick={importSelected}
          disabled={selected.size === 0 || importing}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {importing ? "Queueing..." : `Import ${selected.size} selected`}
        </button>
      </div>

      {notice ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Renders the date in the activity's own zone. `toLocaleDateString` on the
 * bare timestamp would use the *reader's* zone, which moves an evening hike
 * onto the wrong day for anyone browsing from elsewhere -- and the date is
 * how the author recognises which outing a row is.
 */
function formatLocalDate(row: ListingRow): string {
  return new Date(row.startDate).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: row.timezone ?? undefined,
  });
}
