import Link from "next/link";
import { getViewerFromCookies } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { StudioShell } from "../shell";
import { CameraList, type CameraProfile } from "./camera-list";
import { SettingsForm, type AccountSettings } from "./settings-form";

// Session-gated and per-request, for the same reason /studio is: this page
// renders one account's private state, and a shared cache entry here is the
// most direct privacy bug available.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings",
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const userId = await getViewerFromCookies();

  if (!userId) {
    return (
      <StudioShell current="/studio/settings">
        <p className="mt-8 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <Link href="/studio" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          to change your settings.
        </p>
      </StudioShell>
    );
  }

  const account = await withUser(userId, async (client) => {
    const { rows } = await client.query<{
      handle: string;
      display_name: string;
      profile_visibility: "public" | "private";
      privacy_radius_m: number;
      privacy_lat: number | null;
      privacy_lon: number | null;
    }>(
      `select handle, display_name, profile_visibility, privacy_radius_m,
              st_y(privacy_center::geometry) as privacy_lat,
              st_x(privacy_center::geometry) as privacy_lon
       from users where id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  });

  if (!account) {
    return (
      <StudioShell current="/studio/settings">
        <p className="mt-8 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Your account could not be loaded. Try reloading the page.
        </p>
      </StudioShell>
    );
  }

  const cameras = await withUser(userId, async (client) => {
    const { rows } = await client.query<CameraProfile>(
      `select cp.id, cp.make, cp.model, cp.body_serial, cp.clock_offset_s, cp.offset_source,
              cp.calibrated_at::text as calibrated_at,
              (select count(*) from photos p where p.camera_id = cp.id) as photo_count
       from camera_profiles cp where cp.user_id = $1
       order by cp.make, cp.model`,
      [userId],
    );
    return rows;
  });

  const initial: AccountSettings = {
    handle: account.handle,
    displayName: account.display_name,
    profileVisibility: account.profile_visibility,
    privacyRadiusM: account.privacy_radius_m,
    privacyCenter:
      account.privacy_lat != null && account.privacy_lon != null
        ? { lat: account.privacy_lat, lon: account.privacy_lon }
        : null,
  };

  return (
    <StudioShell current="/studio/settings">
      <section className="mt-8">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">Account</h2>
        <div className="mt-4">
          <SettingsForm initial={initial} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">Cameras</h2>
        <div className="mt-4">
          <CameraList cameras={cameras} />
        </div>
      </section>
    </StudioShell>
  );
}
