"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface AccountSettings {
  handle: string;
  displayName: string;
  profileVisibility: "public" | "private";
  privacyRadiusM: number;
  privacyCenter: { lat: number; lon: number } | null;
}

type Status = "idle" | "saving" | "saved" | "taken" | "invalid" | "error";

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400";

export function SettingsForm({ initial }: { initial: AccountSettings }) {
  const router = useRouter();
  const [handle, setHandle] = useState(initial.handle);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [visibility, setVisibility] = useState(initial.profileVisibility);
  // Held as strings: an empty coordinate box is a state the form has to be
  // able to be in, and a number-typed state would have to invent a 0 for it --
  // which is a real place in the Gulf of Guinea, not an absent one.
  const [radius, setRadius] = useState(String(initial.privacyRadiusM));
  const [lat, setLat] = useState(initial.privacyCenter ? String(initial.privacyCenter.lat) : "");
  const [lon, setLon] = useState(initial.privacyCenter ? String(initial.privacyCenter.lon) : "");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    try {
      const response = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle,
          displayName,
          profileVisibility: visibility,
          privacyRadiusM: Number(radius) || 0,
          privacyCenter: lat.trim() && lon.trim() ? { lat: Number(lat), lon: Number(lon) } : null,
        }),
      });
      if (response.status === 409) return setStatus("taken");
      if (response.status === 400) return setStatus("invalid");
      if (!response.ok) return setStatus("error");
      setStatus("saved");
      // The server component above re-reads the account, so a changed handle
      // is reflected in the profile link without a full page load.
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-6" noValidate>
      <div>
        <label
          htmlFor="displayName"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <label
          htmlFor="handle"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Handle
        </label>
        <input
          id="handle"
          name="handle"
          type="text"
          required
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          className={FIELD_CLASS}
        />
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Your profile is at /@{handle}. Changing it changes the address of every outing you have
          published.
        </p>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Account visibility
        </legend>
        <div className="mt-2 space-y-2">
          <VisibilityChoice
            value="public"
            checked={visibility === "public"}
            onChange={setVisibility}
            label="Public"
            description="Anyone can see the outings you publish."
          />
          {/* §9: while signup is closed there is nobody to approve, so private
              is effectively owner-only. The copy says that outright rather
              than implying a follower system that does not exist yet. */}
          <VisibilityChoice
            value="private"
            checked={visibility === "private"}
            onChange={setVisibility}
            label="Private"
            description="Only you can see your outings. Your name and handle stay visible, and comments you have left on other people's outings stay where they are."
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Privacy radius
        </legend>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Published tracks are trimmed where they pass within this distance of the point below,
          and photographs taken inside it are left off the public page. A radius of 0 turns this
          off. Your own view of your outings is never trimmed.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">Metres</span>
            <input
              type="number"
              min={0}
              step={10}
              value={radius}
              onChange={(event) => setRadius(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
          <label className="text-sm">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">Latitude</span>
            <input
              type="number"
              step="any"
              value={lat}
              onChange={(event) => setLat(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
          <label className="text-sm">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">Longitude</span>
            <input
              type="number"
              step="any"
              value={lon}
              onChange={(event) => setLon(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={status === "saving"}
        className="rounded-md bg-zinc-900 px-4 py-2 text-base font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {status === "saving" ? "Saving..." : "Save"}
      </button>

      <p className="min-h-5 text-sm" role="status">
        {status === "saved" && <span className="text-zinc-500 dark:text-zinc-400">Saved.</span>}
        {status === "taken" && (
          <span className="text-red-600 dark:text-red-400">That handle is already taken.</span>
        )}
        {status === "invalid" && (
          <span className="text-red-600 dark:text-red-400">
            Handles use lowercase letters, digits, hyphens and underscores.
          </span>
        )}
        {status === "error" && (
          <span className="text-red-600 dark:text-red-400">Something went wrong. Try again.</span>
        )}
      </p>
    </form>
  );
}

function VisibilityChoice({
  value,
  checked,
  onChange,
  label,
  description,
}: {
  value: "public" | "private";
  checked: boolean;
  onChange: (value: "public" | "private") => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex gap-3 text-sm">
      <input
        type="radio"
        name="profileVisibility"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1 accent-[var(--accent)]"
      />
      <span>
        <span className="font-medium text-zinc-900 dark:text-zinc-50">{label}</span>
        <span className="block text-zinc-500 dark:text-zinc-400">{description}</span>
      </span>
    </label>
  );
}
