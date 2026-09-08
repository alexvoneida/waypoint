"use client";

import { useState } from "react";

// node-pg returns bigint aggregates (count(*)) as strings, so photo_count is
// typed to match what the query in page.tsx actually hands back.
export interface CameraProfile {
  id: string;
  make: string;
  model: string;
  body_serial: string | null;
  clock_offset_s: number;
  offset_source: "assumed" | "watch_face" | "manual";
  calibrated_at: string | null;
  photo_count: string;
}

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400";

const BUTTON_CLASS =
  "rounded-md bg-zinc-900 px-4 py-2 text-base font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300";

const SECONDARY_BUTTON_CLASS =
  "rounded-md border border-zinc-300 px-4 py-2 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export function CameraList({ cameras }: { cameras: CameraProfile[] }) {
  return (
    <div className="max-w-md space-y-8">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        A camera&apos;s clock drifts from the real time over months of use. The offset below is
        the signed difference between what the camera says and the truth -- positive if the
        camera runs ahead, negative if it runs behind. Saving it re-places every photograph
        already uploaded from that body.
      </p>
      {cameras.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Cameras appear here once photographs have been uploaded from a body that reports its
          make and model in EXIF.
        </p>
      ) : (
        <ul className="space-y-8">
          {cameras.map((camera) => (
            <li key={camera.id}>
              <CameraRow camera={camera} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Status = "idle" | "saving" | "saved" | "invalid" | "error";

function CameraRow({ camera }: { camera: CameraProfile }) {
  const [offset, setOffset] = useState(String(camera.clock_offset_s));
  const [source, setSource] = useState(camera.offset_source);
  const [calibratedAt, setCalibratedAt] = useState(camera.calibrated_at);
  const [status, setStatus] = useState<Status>("idle");

  async function save(offsetSource: "watch_face" | "manual") {
    setStatus("saving");
    const clockOffsetSeconds = Number(offset);
    if (!Number.isInteger(clockOffsetSeconds)) {
      setStatus("invalid");
      return;
    }
    try {
      const response = await fetch(`/api/cameras/${camera.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clockOffsetSeconds, offsetSource }),
      });
      if (response.status === 400) return setStatus("invalid");
      if (!response.ok) return setStatus("error");
      setSource(offsetSource);
      setCalibratedAt(new Date().toISOString());
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
        {camera.make.toUpperCase()} {camera.model.toUpperCase()}
      </h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {Number(camera.photo_count)} photograph{Number(camera.photo_count) === 1 ? "" : "s"}
      </p>

      <div className="mt-3 flex items-end gap-3">
        <label className="text-sm">
          <span className="block font-medium text-zinc-700 dark:text-zinc-300">
            Offset (seconds)
          </span>
          <input
            type="number"
            step={1}
            value={offset}
            onChange={(event) => setOffset(event.target.value)}
            className={FIELD_CLASS}
          />
        </label>
        <button
          type="button"
          disabled={status === "saving"}
          onClick={() => save("manual")}
          className={BUTTON_CLASS}
        >
          {status === "saving" ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          disabled={status === "saving"}
          onClick={() => save("watch_face")}
          className={SECONDARY_BUTTON_CLASS}
        >
          Calibrated against a watch face
        </button>
      </div>

      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Source: {sourceLabel(source)}
        {calibratedAt ? ` · calibrated ${new Date(calibratedAt).toLocaleDateString()}` : ""}
      </p>

      <p className="min-h-5 text-sm" role="status">
        {status === "saved" && <span className="text-zinc-500 dark:text-zinc-400">Saved.</span>}
        {status === "invalid" && (
          <span className="text-red-600 dark:text-red-400">
            Enter a whole number of seconds between -86400 and 86400.
          </span>
        )}
        {status === "error" && (
          <span className="text-red-600 dark:text-red-400">Something went wrong. Try again.</span>
        )}
      </p>
    </div>
  );
}

function sourceLabel(source: CameraProfile["offset_source"]): string {
  switch (source) {
    case "watch_face":
      return "watch face";
    case "manual":
      return "manual";
    case "assumed":
      return "not calibrated";
  }
}
