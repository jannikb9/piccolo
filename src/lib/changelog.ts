export type Release = {
  version: string;
  /** As written in the heading, e.g. "2026-10-07". */
  date: string | null;
  /** The section's Markdown. */
  notes: string;
};

/** CHANGELOG.md's `## <version> — <date>` sections newer than `current`, in the file's order. */
export function releasesSince(changelog: string, current: string): Release[] {
  return changelog.split(/^(?=## )/m).flatMap((section) => {
    const newline = section.indexOf("\n");
    const heading = (newline === -1 ? section : section.slice(0, newline)).match(/^## (\S+)(?:\s+—\s+(.+))?/);
    if (!heading || compareVersions(heading[1], current) <= 0) return [];
    return [{ version: heading[1], date: heading[2]?.trim() ?? null, notes: newline === -1 ? "" : section.slice(newline).trim() }];
  });
}

/** Compares `major.minor.patch` versions; anything after a "-" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** "2026-10-07" → "October 7, 2026"; other text as it is. */
export function formatReleaseDate(date: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00`) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : date;
}
