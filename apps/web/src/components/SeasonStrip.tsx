const MONTHS = [
  { label: "J", name: "January" },
  { label: "F", name: "February" },
  { label: "M", name: "March" },
  { label: "A", name: "April" },
  { label: "M", name: "May" },
  { label: "J", name: "June" },
  { label: "J", name: "July" },
  { label: "A", name: "August" },
  { label: "S", name: "September" },
  { label: "O", name: "October" },
  { label: "N", name: "November" },
  { label: "D", name: "December" },
];

// An index, not a chart: which of the twelve months has at least one visible
// visit, read at a glance without axes or a legend. `months` is 1-12. A
// single-letter label repeats across a few months (J, M, A twice each), so
// each dot's accessible name spells out the full month rather than leaning on
// the abbreviation.
export function SeasonStrip({ months }: { months: number[] }) {
  const present = new Set(months);
  return (
    <ul className="flex gap-2">
      {MONTHS.map(({ label, name }, index) => {
        const month = index + 1;
        const isPresent = present.has(month);
        return (
          <li
            key={month}
            title={name}
            aria-label={isPresent ? name : `${name}, no visits`}
            className={`text-figures flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium ${
              isPresent
                ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-400 dark:text-zinc-600"
            }`}
          >
            <span aria-hidden>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
