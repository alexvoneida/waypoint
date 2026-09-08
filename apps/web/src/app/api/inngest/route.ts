import { serve } from "inngest/next";
import { inngest } from "@/lib/jobs/client";
import { derive, exifExtract } from "@/lib/jobs/photo";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [exifExtract, derive],
});
