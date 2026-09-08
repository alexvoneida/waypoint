"use client";

import { useState } from "react";
import type { EntryPhoto } from "@/lib/entries";
import { BlurredImage } from "./BlurredImage";
import { formatAperture, formatFocalLength } from "./format";

const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 427;

interface PhotoStripProps {
  photos: EntryPhoto[];
  activePhotoId: string | null;
  onHoverPhoto: (id: string | null) => void;
  onClickPhoto: (id: string) => void;
}

function exifLine(photo: EntryPhoto): string | null {
  const parts: string[] = [];
  if (photo.lens) parts.push(photo.lens);
  if (photo.focalLength != null) parts.push(formatFocalLength(photo.focalLength));
  if (photo.aperture != null) parts.push(formatAperture(photo.aperture));
  if (photo.iso != null) parts.push(`ISO ${photo.iso}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function PhotoStrip({ photos, activePhotoId, onHoverPhoto, onClickPhoto }: PhotoStripProps) {
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const lightboxPhoto = photos.find((photo) => photo.id === lightboxId) ?? null;

  return (
    <>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((photo) => {
          const width = photo.width ?? FALLBACK_WIDTH;
          const height = photo.height ?? FALLBACK_HEIGHT;
          const isActive = activePhotoId === photo.id;
          const caption = exifLine(photo);
          return (
            <li
              key={photo.id}
              onMouseEnter={() => onHoverPhoto(photo.id)}
              onMouseLeave={() => onHoverPhoto(null)}
            >
              <BlurredImage
                src={`/i/${photo.id}/thumb`}
                blurHash={photo.blurHash}
                width={width}
                height={height}
                alt={caption ?? ""}
                className={`cursor-pointer rounded-sm ring-2 ring-offset-2 ring-offset-[var(--background)] transition-[ring-color] ${
                  isActive ? "ring-[var(--accent)]" : "ring-transparent"
                }`}
                onClick={() => {
                  onClickPhoto(photo.id);
                  setLightboxId(photo.id);
                }}
              />
              {caption && (
                <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{caption}</p>
              )}
            </li>
          );
        })}
      </ul>

      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightboxId(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- served through the entry-scoped /i route */}
          <img
            src={`/i/${lightboxPhoto.id}/full`}
            alt={exifLine(lightboxPhoto) ?? ""}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </>
  );
}
