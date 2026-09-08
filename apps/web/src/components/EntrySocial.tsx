"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { EntrySocial as EntrySocialPayload, SocialComment } from "@/lib/social";

type Status = "loading" | "ready" | "error";
type SubmitStatus = "idle" | "submitting" | "rateLimited" | "closed" | "error";

const URL_PATTERN = /(https?:\/\/[^\s]+)/g;

// Splits a comment body around bare URLs so links are auto-detected without
// any HTML sanitiser: React escapes every plain-text segment it renders, so
// the only thing that ever becomes markup here is the anchor this function
// builds itself, and dangerouslySetInnerHTML never enters the picture.
function renderBody(body: string): ReactNode[] {
  return body.split(URL_PATTERN).map((segment, index) =>
    /^https?:\/\//.test(segment) ? (
      <a
        key={index}
        href={segment}
        target="_blank"
        rel="nofollow noopener noreferrer"
        className="underline underline-offset-2"
      >
        {segment}
      </a>
    ) : (
      segment
    ),
  );
}

function formatCommentDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function likeLabel(likeCount: number): string {
  return likeCount === 1 ? "1 like" : `${likeCount} likes`;
}

export function EntrySocial({ entryId }: { entryId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [social, setSocial] = useState<EntrySocialPayload | null>(null);
  const [draft, setDraft] = useState("");
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");

  // Fetches and returns; it never writes state itself, so a caller can
  // decide whether the answer is still wanted before acting on it.
  const fetchSocial = useCallback(async (): Promise<EntrySocialPayload | null> => {
    try {
      const response = await fetch(`/api/entries/${entryId}/social`);
      if (!response.ok) return null;
      return (await response.json()) as EntrySocialPayload;
    } catch {
      return null;
    }
  }, [entryId]);

  useEffect(() => {
    // Guards against setting state from a response that resolves after the
    // entry id has already changed or the component has unmounted.
    let current = true;
    void fetchSocial().then((payload) => {
      if (!current) return;
      if (payload) {
        setSocial(payload);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    });
    return () => {
      current = false;
    };
  }, [fetchSocial]);

  async function handleLikeToggle() {
    if (!social) return;
    const previousLiked = social.viewerLiked;
    const previousCount = social.likeCount;
    // Optimistic update: flip the button and count immediately so liking
    // feels instant, then revert both if the request turns out to fail.
    setSocial({
      ...social,
      viewerLiked: !previousLiked,
      likeCount: previousLiked ? previousCount - 1 : previousCount + 1,
    });
    try {
      const response = await fetch(`/api/entries/${entryId}/like`, {
        method: previousLiked ? "DELETE" : "PUT",
      });
      if (!response.ok) {
        setSocial({ ...social, viewerLiked: previousLiked, likeCount: previousCount });
      }
    } catch {
      setSocial({ ...social, viewerLiked: previousLiked, likeCount: previousCount });
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!social) return;
    const response = await fetch(`/api/comments/${commentId}`, { method: "DELETE" });
    if (response.ok) {
      setSocial({
        ...social,
        comments: social.comments.filter((comment) => comment.id !== commentId),
      });
    }
  }

  async function handleSubmitComment() {
    const body = draft.trim();
    if (!body || submitStatus === "submitting") return;
    setSubmitStatus("submitting");
    try {
      const response = await fetch(`/api/entries/${entryId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (response.status === 429) {
        setSubmitStatus("rateLimited");
        return;
      }
      if (response.status === 403) {
        setSubmitStatus("closed");
        return;
      }
      if (!response.ok) {
        setSubmitStatus("error");
        return;
      }
      setDraft("");
      setSubmitStatus("idle");
      // Simplest correct refresh: re-fetch the whole payload rather than
      // splicing the new comment into local state by hand.
      const payload = await fetchSocial();
      if (payload) setSocial(payload);
    } catch {
      setSubmitStatus("error");
    }
  }

  return (
    // Reserves space while loading: the entry page is statically generated
    // and this arrives after hydration, so a fixed minimum height stands in
    // for the eventual content instead of letting it shift the layout in
    // once the fetch resolves (PRD §7).
    <div className="min-h-32">
      <h2 className="text-section-heading text-zinc-900 dark:text-zinc-50">Responses</h2>

      {status === "loading" && (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>
      )}

      {status === "error" && (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          Likes and comments could not be loaded. Reloading the page usually fixes this.
        </p>
      )}

      {status === "ready" && social && (
        <div className="mt-4 space-y-6">
          <div>
            {social.canInteract ? (
              <button
                type="button"
                onClick={handleLikeToggle}
                className={
                  social.viewerLiked
                    ? "text-sm font-medium text-[var(--accent)]"
                    : "text-sm font-medium text-zinc-500 dark:text-zinc-400"
                }
              >
                {likeLabel(social.likeCount)}
              </button>
            ) : (
              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                {likeLabel(social.likeCount)}
              </span>
            )}
          </div>

          {!social.commentsOpen && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Comments are closed on this outing.
            </p>
          )}

          {social.commentsOpen && (
            <div className="space-y-4">
              {social.comments.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {social.canInteract
                    ? "No comments yet. Be the first to leave one."
                    : "No comments yet."}
                </p>
              ) : (
                <ul className="space-y-4">
                  {social.comments.map((comment) => (
                    <CommentRow key={comment.id} comment={comment} onDelete={handleDeleteComment} />
                  ))}
                </ul>
              )}

              {social.canInteract && (
                <div className="space-y-2 border-t border-zinc-300 pt-4 dark:border-zinc-700">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    A comment is public writing under your handle, visible to anyone who can see
                    this outing.
                  </p>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400"
                  />
                  <button
                    type="button"
                    onClick={handleSubmitComment}
                    disabled={submitStatus === "submitting" || draft.trim().length === 0}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-base font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {submitStatus === "submitting" ? "Posting..." : "Post"}
                  </button>
                  <p className="min-h-5 text-sm" role="status">
                    {submitStatus === "rateLimited" && (
                      <span className="text-red-600 dark:text-red-400">
                        You are commenting too quickly. Try again shortly.
                      </span>
                    )}
                    {submitStatus === "closed" && (
                      <span className="text-red-600 dark:text-red-400">
                        Comments are closed on this outing.
                      </span>
                    )}
                    {submitStatus === "error" && (
                      <span className="text-red-600 dark:text-red-400">
                        Something went wrong. Try again.
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  onDelete,
}: {
  comment: SocialComment;
  onDelete: (commentId: string) => void;
}) {
  return (
    <li>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-zinc-900 dark:text-zinc-50">
          {comment.authorDisplayName}
        </span>{" "}
        <Link href={`/@${comment.authorHandle}`} className="underline underline-offset-2">
          @{comment.authorHandle}
        </Link>{" "}
        · <span className="text-figures">{formatCommentDate(comment.createdAt)}</span>
        {comment.canDelete && (
          <>
            {" "}
            ·{" "}
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              className="underline underline-offset-2"
            >
              Delete
            </button>
          </>
        )}
      </p>
      <p className="mt-1 text-base text-zinc-900 dark:text-zinc-50">{renderBody(comment.body)}</p>
    </li>
  );
}
