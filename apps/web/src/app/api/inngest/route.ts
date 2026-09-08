import { serve } from "inngest/next";
import { inngest } from "@/lib/jobs/client";
import { photoCorrelateCheck } from "@/lib/jobs/correlate";
import { derive, exifExtract } from "@/lib/jobs/photo";
import { trailMatch } from "@/lib/jobs/trail";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [exifExtract, derive, photoCorrelateCheck, trailMatch],
});
