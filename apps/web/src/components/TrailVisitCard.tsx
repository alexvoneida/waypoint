import Link from "next/link";
import type { TrailVisit } from "@/lib/trail-page";
import { BlurredImage } from "./BlurredImage";
import { StatisticsBar } from "./StatisticsBar";

const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 427;

export function TrailVisitCard({ visit }: { visit: TrailVisit }) {
  return (
    <li>
      <Link href={`/e/${visit.authorHandle}/${visit.entrySlug}`} className="group block">
        {visit.leadPhoto ? (
          <BlurredImage
            src={`/i/${visit.leadPhoto.id}/web`}
            blurHash={visit.leadPhoto.blurHash}
            width={visit.leadPhoto.width ?? FALLBACK_WIDTH}
            height={visit.leadPhoto.height ?? FALLBACK_HEIGHT}
            alt=""
            className="rounded-sm"
          />
        ) : (
          <div className="aspect-[3/2] rounded-sm bg-zinc-100 dark:bg-zinc-900" />
        )}
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">@{visit.authorHandle}</p>
        <h3 className="mt-1 text-lg font-medium text-zinc-900 group-hover:text-[var(--accent)] dark:text-zinc-50">
          {visit.title}
        </h3>
      </Link>
      <div className="mt-3">
        <StatisticsBar stats={visit.stats} />
      </div>
    </li>
  );
}
