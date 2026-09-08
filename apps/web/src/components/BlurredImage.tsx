"use client";

import { useEffect, useRef, useState } from "react";
import { decode } from "blurhash";

const RASTER_EDGE = 32;

// Decodes photos.blur_hash into a tiny canvas and shows it as a placeholder
// until the real image finishes loading, so the layout never shifts (the
// wrapper already reserves the right aspect ratio via width/height) and
// there is no blank tile while the network catches up.
export function BlurredImage({
  src,
  blurHash,
  width,
  height,
  alt,
  className,
  onClick,
  priority = false,
}: {
  src: string;
  blurHash: string | null;
  width: number;
  height: number;
  alt: string;
  className?: string;
  onClick?: () => void;
  // Set for the single above-the-fold image a page leads with - its LCP
  // candidate - so it is fetched eagerly and at high priority instead of
  // competing with everything else below the fold, which stays lazy.
  priority?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!blurHash) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    try {
      const pixels = decode(blurHash, RASTER_EDGE, RASTER_EDGE);
      const imageData = ctx.createImageData(RASTER_EDGE, RASTER_EDGE);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // A malformed hash just means no placeholder; the real image below
      // still loads normally.
    }
  }, [blurHash]);

  return (
    <div
      className={className}
      style={{ position: "relative", aspectRatio: `${width} / ${height}`, overflow: "hidden" }}
      onClick={onClick}
    >
      {blurHash && (
        <canvas
          ref={canvasRef}
          width={RASTER_EDGE}
          height={RASTER_EDGE}
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: loaded ? 0 : 1,
            transition: "opacity 300ms ease",
          }}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- served through the entry-scoped /i route, not a next/image remote source */}
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        onLoad={() => setLoaded(true)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: loaded ? 1 : 0,
          transition: "opacity 300ms ease",
        }}
      />
    </div>
  );
}
