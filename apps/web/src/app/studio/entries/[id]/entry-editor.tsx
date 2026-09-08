"use client";

import * as maplibregl from "maplibre-gl";
import type { LngLatBoundsLike, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { trackPositions, type TrackGeometry } from "@/lib/track-geojson";

// See the identical workaround and explanation in components/EntryMap.tsx:
// maplibre-gl's worker URL does not resolve correctly under Turbopack, and
// without this call the map silently never paints past a blank canvas.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400";

const BUTTON_CLASS =
  "rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300";

const QUIET_BUTTON_CLASS =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition-colors hover:border-zinc-500 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500";

export interface EditorEntry {
  id: string;
  title: string;
  notes: string | null;
  slug: string | null;
  status: "draft" | "published";
  visibility: "public" | "private";
  commentsOpen: boolean;
  leadPhotoId: string | null;
  handle: string;
}

export interface EditorPhoto {
  id: string;
  hidden: boolean;
  sortOrder: number | null;
  width: number | null;
  height: number | null;
  blurHash: string | null;
  capturedAt: string | null;
  method: string | null;
  confidence: string | null;
  position: { lon: number; lat: number } | null;
}

export function EntryEditor({
  entry,
  photos: initialPhotos,
  trackGeojson,
}: {
  entry: EditorEntry;
  photos: EditorPhoto[];
  trackGeojson: TrackGeometry | null;
}) {
  const [photos, setPhotos] = useState<EditorPhoto[]>(initialPhotos);
  // Tracks the most recently seen `initialPhotos` reference so a genuinely
  // new server payload (a router.refresh() after publishing, or after a pin
  // correction) can be adopted during render rather than through an effect.
  // Local edits in between -- hide/show, reordering, the lead photo -- are
  // applied optimistically and already committed to the server before this
  // runs, so overwriting them here on a real refresh never loses anything.
  const [syncedPhotos, setSyncedPhotos] = useState(initialPhotos);
  if (initialPhotos !== syncedPhotos) {
    setSyncedPhotos(initialPhotos);
    setPhotos(initialPhotos);
  }

  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId) ?? null;

  return (
    <div className="mt-8 space-y-14">
      <h2 className="text-card-title text-zinc-900 dark:text-zinc-50">{entry.title}</h2>

      <DetailsSection entry={entry} />

      <PublishSection entry={entry} />

      <PhotographsSection
        entryId={entry.id}
        leadPhotoId={entry.leadPhotoId}
        photos={photos}
        setPhotos={setPhotos}
        selectedPhotoId={selectedPhotoId}
        onSelectPhoto={setSelectedPhotoId}
      />

      {selectedPhoto && trackGeojson ? (
        <PinCorrectionSection
          key={selectedPhoto.id}
          photo={selectedPhoto}
          trackGeojson={trackGeojson}
        />
      ) : null}
    </div>
  );
}

type DetailsStatus = "idle" | "saving" | "saved" | "error";

function DetailsSection({ entry }: { entry: EditorEntry }) {
  const [title, setTitle] = useState(entry.title);
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [visibility, setVisibility] = useState(entry.visibility);
  const [commentsOpen, setCommentsOpen] = useState(entry.commentsOpen);
  const [status, setStatus] = useState<DetailsStatus>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    try {
      const response = await fetch(`/api/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, notes, visibility, commentsOpen }),
      });
      setStatus(response.ok ? "saved" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section>
      <h3 className="text-subsection-heading text-zinc-900 dark:text-zinc-50">Details</h3>
      <form onSubmit={handleSubmit} className="mt-4 max-w-md space-y-6" noValidate>
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Title
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Visibility</legend>
          <div className="mt-2 space-y-2">
            <VisibilityChoice
              value="public"
              checked={visibility === "public"}
              onChange={setVisibility}
              label="Public"
              description="Anyone can see this outing once it is published."
            />
            <VisibilityChoice
              value="private"
              checked={visibility === "private"}
              onChange={setVisibility}
              label="Private"
              description="Only you can see this outing."
            />
          </div>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            An entry is only public if your account is too -- the effective visibility is whichever
            of the two is more restrictive.
          </p>
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={commentsOpen}
            onChange={(event) => setCommentsOpen(event.target.checked)}
          />
          Comments open
        </label>

        <button type="submit" disabled={status === "saving"} className={BUTTON_CLASS}>
          {status === "saving" ? "Saving..." : "Save"}
        </button>

        <p className="min-h-5 text-sm" role="status">
          {status === "saved" && <span className="text-zinc-500 dark:text-zinc-400">Saved.</span>}
          {status === "error" && (
            <span className="text-red-600 dark:text-red-400">Something went wrong. Try again.</span>
          )}
        </p>
      </form>
    </section>
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
        name="visibility"
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

type PublishStatus = "idle" | "publishing" | "error";

function PublishSection({ entry }: { entry: EditorEntry }) {
  const router = useRouter();
  const [status, setStatus] = useState<PublishStatus>("idle");
  const [publishedUrl, setPublishedUrl] = useState<string | null>(
    entry.status === "published" && entry.slug ? `/e/${entry.handle}/${entry.slug}` : null,
  );

  async function publish() {
    setStatus("publishing");
    try {
      const response = await fetch(`/api/entries/${entry.id}/publish`, { method: "POST" });
      if (!response.ok) {
        setStatus("error");
        return;
      }
      const payload = (await response.json()) as { url: string };
      setPublishedUrl(payload.url);
      setStatus("idle");
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <section>
      <h3 className="text-subsection-heading text-zinc-900 dark:text-zinc-50">Publish</h3>
      {publishedUrl ? (
        <div className="mt-3 space-y-1">
          <a
            href={publishedUrl}
            className="text-sm text-zinc-900 underline underline-offset-4 dark:text-zinc-50"
          >
            {publishedUrl}
          </a>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Re-publishing is not needed: saved edits revalidate this page automatically.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <button type="button" onClick={publish} disabled={status === "publishing"} className={BUTTON_CLASS}>
            {status === "publishing" ? "Publishing..." : "Publish"}
          </button>
          {status === "error" && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              Something went wrong. Try again.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PhotographsSection({
  entryId,
  leadPhotoId,
  photos,
  setPhotos,
  selectedPhotoId,
  onSelectPhoto,
}: {
  entryId: string;
  leadPhotoId: string | null;
  photos: EditorPhoto[];
  setPhotos: (updater: (current: EditorPhoto[]) => EditorPhoto[]) => void;
  selectedPhotoId: string | null;
  onSelectPhoto: (id: string | null) => void;
}) {
  const [currentLeadPhotoId, setCurrentLeadPhotoId] = useState(leadPhotoId);

  async function toggleHidden(photo: EditorPhoto) {
    const hidden = !photo.hidden;
    setPhotos((current) =>
      current.map((candidate) => (candidate.id === photo.id ? { ...candidate, hidden } : candidate)),
    );
    await fetch(`/api/photos/${photo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden }),
    });
  }

  async function move(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= photos.length) return;

    const reordered = [...photos];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved!);
    setPhotos(() => reordered);

    // A null sort_order means "capture order" -- the list is already in that
    // order because the query orders by it. The first explicit reorder is
    // what materialises an index for every photo in the list, not just the
    // two that moved, so a later insertion elsewhere still has a well-defined
    // position to slot into.
    await Promise.all(
      reordered.map((photo, sortOrder) =>
        fetch(`/api/photos/${photo.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sortOrder }),
        }),
      ),
    );
  }

  async function markAsLead(photoId: string) {
    setCurrentLeadPhotoId(photoId);
    await fetch(`/api/entries/${entryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leadPhotoId: photoId }),
    });
  }

  return (
    <section>
      <h3 className="text-subsection-heading text-zinc-900 dark:text-zinc-50">Photographs</h3>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        A hidden photograph stays attached to this outing but is left off the public page.
      </p>

      <ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
        {photos.map((photo, index) => (
          <li key={photo.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- served through the entry-scoped /i route */}
              <img
                src={`/i/${photo.id}/thumb`}
                alt=""
                width={96}
                height={96}
                loading="lazy"
                className="h-20 w-20 shrink-0 rounded-sm object-cover sm:h-24 sm:w-24"
              />

              <div className="min-w-0 flex-1 text-sm">
                <p className="text-zinc-600 dark:text-zinc-400">
                  {photo.method ? `Placed by ${photo.method} (${photo.confidence})` : "Not placed"}
                </p>
                {currentLeadPhotoId === photo.id ? (
                  <p className="mt-1 text-zinc-500 dark:text-zinc-400">Lead photo</p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className={QUIET_BUTTON_CLASS} onClick={() => toggleHidden(photo)}>
                {photo.hidden ? "Show" : "Hide"}
              </button>
              <button
                type="button"
                className={QUIET_BUTTON_CLASS}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                className={QUIET_BUTTON_CLASS}
                disabled={index === photos.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                className={QUIET_BUTTON_CLASS}
                disabled={currentLeadPhotoId === photo.id}
                onClick={() => markAsLead(photo.id)}
              >
                Use as lead
              </button>
              <button
                type="button"
                className={QUIET_BUTTON_CLASS}
                disabled={selectedPhotoId === photo.id}
                onClick={() => onSelectPhoto(photo.id)}
              >
                Correct pin
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TRACK_SOURCE = "correction-track";
const TRACK_LAYER = "correction-track-line";
const PIN_SOURCE = "correction-pin";
const PIN_LAYER = "correction-pin-circle";
const ACCENT = "#c2571a";

// Positions, not coordinates: a track clipped by the privacy radius arrives
// as a MultiLineString, and reading .coordinates off one directly would
// iterate segments rather than points. Mirrors trackBounds in EntryMap.tsx.
function trackBounds(geometry: TrackGeometry): LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds();
  for (const position of trackPositions(geometry)) {
    bounds.extend([position[0]!, position[1]!]);
  }
  return bounds;
}

function PinCorrectionSection({
  photo,
  trackGeojson,
}: {
  photo: EditorPhoto;
  trackGeojson: TrackGeometry;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apiKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;
    const map = new maplibregl.Map({
      container,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${apiKey}`,
      bounds: trackBounds(trackGeojson),
      fitBoundsOptions: { padding: 32 },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource(TRACK_SOURCE, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: trackGeojson },
      });
      map.addLayer({
        id: TRACK_LAYER,
        type: "line",
        source: TRACK_SOURCE,
        paint: { "line-color": ACCENT, "line-width": 3 },
      });

      map.addSource(PIN_SOURCE, {
        type: "geojson",
        data: photo.position
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "Point", coordinates: [photo.position.lon, photo.position.lat] },
                },
              ],
            }
          : { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: PIN_LAYER,
        type: "circle",
        source: PIN_SOURCE,
        paint: {
          "circle-radius": 7,
          "circle-color": ACCENT,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    });

    map.on("click", async (event: MapMouseEvent) => {
      setStatus("saving");
      try {
        const response = await fetch(`/api/photos/${photo.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ position: { lat: event.lngLat.lat, lon: event.lngLat.lng } }),
        });
        if (!response.ok) {
          setStatus("error");
          return;
        }
        setStatus("idle");
        // The endpoint returns only { ok: true }, not the snapped position, so
        // the corrected pin is picked up by re-reading the page rather than by
        // updating local state from a response that has nothing to update it
        // with.
        router.refresh();
      } catch {
        setStatus("error");
      }
    });

    return () => {
      map.remove();
    };
    // The map is built once per selected photo (the parent remounts this
    // component with a `key` when the selection changes), so it intentionally
    // does not react to prop changes after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section>
      <h3 className="text-subsection-heading text-zinc-900 dark:text-zinc-50">Correct pin</h3>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        The pin snaps to the nearest point on the recorded track. A corrected pin is kept even if
        correlation runs again.
      </p>
      <div ref={containerRef} className="mt-4 h-96 w-full" />
      {status === "error" && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          The pin could not be saved. Try again.
        </p>
      )}
    </section>
  );
}
