export interface TaggedFile {
  file: string;
  tags: string[];
}

export interface TagCheckResult {
  errors: string[];
  covered: string[];
}

const TAG = /\[(TC-[A-Z]+-\d{3}-[HN]|TC-RACE-\d{2})\]/g;

/** Scenario IDs written as `[TC-…]` in test titles. */
export function extractTcTags(source: string): string[] {
  return [...source.matchAll(TAG)].map((match) => match[1] as string);
}

/** Every tag must name a scenario from tests/test-catalog.json. */
export function checkTcTags(files: TaggedFile[], catalog: ReadonlySet<string>): TagCheckResult {
  const errors: string[] = [];
  const covered = new Set<string>();
  for (const { file, tags } of files) {
    for (const tag of tags) {
      if (catalog.has(tag)) covered.add(tag);
      else errors.push(`${file}: unknown test scenario ${tag}`);
    }
  }
  return { errors, covered: [...covered].sort() };
}
