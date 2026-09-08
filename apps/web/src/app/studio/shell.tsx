import Link from "next/link";

const SECTIONS = [
  { href: "/studio", label: "Overview" },
  { href: "/studio/entries", label: "Outings" },
  { href: "/studio/strava", label: "Strava" },
  { href: "/studio/settings", label: "Settings" },
] as const;

export function StudioShell({
  current,
  children,
}: {
  current: (typeof SECTIONS)[number]["href"];
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8 sm:py-20">
      <h1 className="text-page-title text-zinc-900 dark:text-zinc-50">Studio</h1>
      <nav className="mt-6 flex gap-5 border-b border-zinc-200 pb-4 text-sm dark:border-zinc-800">
        {SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            aria-current={section.href === current ? "page" : undefined}
            className={
              section.href === current
                ? "font-medium text-zinc-900 dark:text-zinc-50"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
            }
          >
            {section.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
