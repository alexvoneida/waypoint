import type { Metadata } from "next";
import { WaitlistForm } from "./waitlist-form";

export const metadata: Metadata = {
  title: "Join the Waypoint waitlist",
  description: "Signup is closed while Waypoint is in early development. Leave your email to hear when it opens.",
};

export default function SignupPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Waypoint
        </h1>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Waypoint reads the timestamps your dedicated camera writes into every
          photo and lines them up against a GPS track from the same hike, so
          each frame lands on the exact point of the route it was taken from.
        </p>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Signup is closed while it is still being built. Leave your email and
          we will let you know when it opens.
        </p>
        <div className="mt-10">
          <WaitlistForm />
        </div>
      </div>
    </div>
  );
}
