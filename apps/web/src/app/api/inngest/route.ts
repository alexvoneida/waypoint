import { serve } from "inngest/next";
import { inngest } from "@/lib/jobs/client";
import { photoCorrelateCheck } from "@/lib/jobs/correlate";
import { derive, exifExtract } from "@/lib/jobs/photo";
import { stravaBackfillList } from "@/lib/jobs/strava-backfill";
import { trailMatch } from "@/lib/jobs/trail";
import { trailName } from "@/lib/jobs/trail-name";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [exifExtract, derive, photoCorrelateCheck, trailMatch, trailName, stravaBackfillList],
});
