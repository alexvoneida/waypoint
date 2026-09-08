import { withUser } from "@/lib/db";
import { matchActivityToTrail } from "@/lib/trail-match";
import { inngest } from "./client";

interface ActivityEventData {
  activityId: string;
  userId: string;
}

// Section 7's job graph draws trail.match after correlate, since that is the
// order the pipeline stages were designed in. But trail matching depends only
// on an activity's track -- never on a photograph or a correlation result --
// so triggering it as soon as the activity exists (rather than waiting for
// correlate to finish, or for any photo to be uploaded at all) is a
// deliberate deviation: it gets a trail page populated sooner without
// changing what trail.match itself needs to run.
export const trailMatch = inngest.createFunction(
  { id: "trail-match", retries: 3, triggers: [{ event: "activity/created" }] },
  async ({ event, step }) => {
    const { activityId, userId } = event.data as ActivityEventData;
    return step.run("match-trail", () =>
      withUser(userId, (client) => matchActivityToTrail(client, activityId)),
    );
  },
);
