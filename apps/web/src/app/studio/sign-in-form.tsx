"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "rate-limited" | "rejected" | "error";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    try {
      const response = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 429) return setStatus("rate-limited");
      // Deliberately one message for both a wrong password and an unknown
      // email, matching what the endpoint itself returns: distinguishing them
      // here would hand back exactly the enumeration the timing-safe verify
      // in lib/auth exists to prevent.
      if (response.status === 401) return setStatus("rejected");
      if (!response.ok) return setStatus("error");

      // The session cookie is set on the response; refresh() re-runs the
      // server component so the page renders as signed in.
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-sm space-y-3" noValidate>
      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
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
          className="mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400"
        />
      </div>
      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-400"
        />
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded-md bg-zinc-900 px-3 py-2 text-base font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {status === "submitting" ? "Signing in..." : "Sign in"}
      </button>
      <p className="min-h-5 text-sm text-red-600 dark:text-red-400" role="status">
        {status === "rejected" && "Incorrect email or password."}
        {status === "rate-limited" && "Too many attempts. Try again later."}
        {status === "error" && "Something went wrong. Try again."}
      </p>
    </form>
  );
}
