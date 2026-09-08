"use client";

import { useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "done" | "rate-limited" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (response.status === 429) {
        setStatus("rate-limited");
        return;
      }
      if (!response.ok) {
        setStatus("error");
        return;
      }
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <p className="text-base leading-7 text-zinc-900 dark:text-zinc-50">
        You are on the list. We will email you when Waypoint opens.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      <label htmlFor="email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400"
      />
      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded-md bg-zinc-900 px-3 py-2 text-base font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {status === "submitting" ? "Joining..." : "Join the waitlist"}
      </button>
      <p className="min-h-5 text-sm text-red-600 dark:text-red-400" role="status">
        {status === "rate-limited" && "Too many attempts from this connection. Try again later."}
        {status === "error" && "Something went wrong. Try again."}
      </p>
    </form>
  );
}
