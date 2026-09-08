import type { Metadata } from "next";

// Static prose with no data dependency - nothing here changes between
// deploys, so a day-long revalidation window costs nothing and saves a
// render on every visit in between.
export const revalidate = 86400;

export const metadata: Metadata = {
  title: "How it works — Waypoint",
  description:
    "How Waypoint figures out where a photograph was taken: the timezone search, the interpolation, and the confidence score behind every pin.",
};

const REPOSITORY_URL = "https://github.com/alexvoneida/waypoint";

export default function HowItWorksPage() {
  return (
    <article className="mx-auto max-w-2xl px-6 py-16 sm:px-8 sm:py-20">
      <header>
        <h1 className="text-page-title text-zinc-900 dark:text-zinc-50">How it works</h1>
        <p className="mt-5 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Waypoint is not a photo grid. Every photograph on this site is
          placed on a map, and that placement is computed, not entered by
          hand. This page explains how.
        </p>
      </header>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          The problem
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            A dedicated camera has an accurate clock but no GPS. A watch or
            phone has GPS but takes no photographs. The only thing that
            connects a photograph to a position on the trail is the moment it
            was taken — but a camera stamps that moment as a plain
            wall-clock reading, with no time zone attached. &quot;2:32 PM&quot;
            could mean 2:32 PM in Denver, in Kathmandu, or nowhere real at
            all, if the camera&apos;s clock was never set for the trip.
          </p>
          <p>
            Meanwhile the GPS track records its own timestamps in UTC, a
            single global reference. Before the two can be compared, Waypoint
            has to work out what the camera&apos;s local time actually meant
            in UTC.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          Finding the offset
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            Getting the offset wrong by even one hour puts every photograph
            from that hike somewhere else on the trail entirely — often off
            the track altogether. So Waypoint does not assume a time zone; it
            searches for one.
          </p>
          <p>
            It tries every real-world UTC offset, in 15-minute steps (some
            zones, like Nepal&apos;s, sit on a quarter-hour rather than a
            whole one), and checks each candidate against the GPS track: if
            the photographs were shifted by this offset, how many of them
            would land inside the time the activity was actually recorded?
            The offset that explains the most photographs wins.
          </p>
          <p>
            Often more than one offset explains the same set of
            photographs — a few frames taken in the middle of a long hike
            leave hours of slack at both ends, and every offset within that
            slack looks equally good. When that happens, Waypoint prefers an
            offset the photograph&apos;s own metadata claims, if the track
            allows it. Only when neither the track nor the photograph settles
            the question does it fall back to the middle of the plausible
            range and mark the result as ambiguous, rather than quietly
            guessing.
          </p>
          <p>
            A photograph taken before the recording started, or after it
            ended, is not shifted into some nearby time by force — see
            &quot;What this doesn&apos;t do,&quot; below.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          Interpolating a position
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            A GPS track is a list of points, each with a time, a latitude,
            and a longitude, usually a few seconds apart. Once a photograph
            has a real UTC moment, Waypoint finds the two track points that
            bracket it — one just before, one just after — and places the
            photograph on the straight line between them, in proportion to
            how far through that interval its moment falls.
          </p>
          <p>
            A straight line is a simplification of the earth&apos;s
            curvature, but over a few seconds and a few meters of trail, that
            curvature is far smaller than the GPS receiver&apos;s own noise.
            It is not a shortcut that costs anything real.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          A worked example
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            Say a photograph was taken on a Colorado hike, and the camera&apos;s
            clock reads:
          </p>
          <p className="text-figures font-mono text-zinc-800 dark:text-zinc-200">
            2026-06-14 12:03:19 (no time zone recorded)
          </p>
          <p>
            The GPS watch was recording in Mountain Daylight Time, six hours
            behind UTC in June. Applying that offset turns the naive reading
            into a real instant:
          </p>
          <p className="text-figures font-mono text-zinc-800 dark:text-zinc-200">
            12:03:19 + 6:00:00 = 18:03:19 UTC
          </p>
          <p>The track has two points bracketing that instant:</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2 pr-4 font-medium">Point</th>
                  <th className="py-2 pr-4 font-medium">Time (UTC)</th>
                  <th className="py-2 pr-4 font-medium">Latitude</th>
                  <th className="py-2 font-medium">Longitude</th>
                </tr>
              </thead>
              <tbody className="text-figures font-mono text-zinc-800 dark:text-zinc-200">
                <tr className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4">A (before)</td>
                  <td className="py-2 pr-4">18:03:12</td>
                  <td className="py-2 pr-4">39.9950</td>
                  <td className="py-2">-105.2830</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">B (after)</td>
                  <td className="py-2 pr-4">18:03:28</td>
                  <td className="py-2 pr-4">39.9954</td>
                  <td className="py-2">-105.2822</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            The gap between A and B is 16 seconds. The photograph&apos;s
            instant, 18:03:19, falls 7 seconds into that gap:
          </p>
          <p className="text-figures font-mono text-zinc-800 dark:text-zinc-200">
            fraction = (18:03:19 − 18:03:12) / 16s = 7 / 16 = 0.4375
          </p>
          <p>
            Applying that fraction to the latitude and longitude between A
            and B places the photograph at:
          </p>
          <p className="text-figures font-mono text-zinc-800 dark:text-zinc-200">
            39.995175, -105.28265
          </p>
          <p>
            a point 0.4375 of the way from A to B — not at either track
            point, but between them, where the photograph was actually
            taken.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          Confidence
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            An interpolated position is an estimate, and its quality depends
            on the data around it. Waypoint scores every placement as high,
            medium, or low confidence, and only high- and medium-confidence
            placements are drawn on the map and the elevation profile. A
            photograph whose position Waypoint does not trust still appears
            among the others; it simply gets no pin.
          </p>
          <p>
            The two things that lower confidence are a wide gap between the
            bracketing track points, and a high speed across that gap.
          </p>
          <p>
            A gap under 15 seconds is high confidence; up to two minutes is
            medium; beyond that, low. A long gap usually means a tunnel, a
            canyon wall blocking the GPS signal, or a paused watch — the
            interpolated point may be far from where the hiker actually was.
          </p>
          <p>
            Speed matters because hikers stop to take photographs. A frame
            that lands on a segment being covered faster than 3 meters per
            second — a jog, a vehicle, a fast descent — is more likely
            evidence that the time offset is wrong than a photograph taken
            mid-stride.
          </p>
          <p>
            A placement is only as confident as its weakest signal. And when
            the offset search itself was ambiguous — resolved to a midpoint
            guess rather than a single answer — confidence is capped at
            medium, no matter how tight the bracketing points are: a good
            interpolation built on an uncertain offset is still uncertain.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          What this doesn&apos;t do
        </h2>
        <div className="mt-4 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <p>
            A photograph taken before the recording started, or after it
            ended, is listed as unplaced rather than given an invented
            position. It still appears with the hike&apos;s other
            photographs — it just doesn&apos;t get a pin.
          </p>
          <p>
            Elevation gain is never computed from a GPS track&apos;s own
            recorded elevation points. Consumer GPS altitude is noisy enough
            that summing its ups and downs typically overstates gain by a
            wide margin. When an outing comes from Strava, its
            barometer-derived elevation gain and moving time are shown as
            recorded. When it comes from an uploaded GPX file instead,
            neither figure is shown at all — an omitted statistic, rather
            than an invented one.
          </p>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">
          The code
        </h2>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Waypoint is open source. The correlation engine described above
          lives in{" "}
          <a
            href={REPOSITORY_URL}
            className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            the repository
          </a>
          , unit-tested against real hikes.
        </p>
      </section>
    </article>
  );
}
