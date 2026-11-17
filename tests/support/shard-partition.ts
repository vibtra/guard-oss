const median = (values: readonly number[]): number => {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
};

export const partition = (files: readonly string[], durations: Readonly<Record<string, number>>, count: number): string[][] => {
  const guess = median(Object.values(durations));
  const weighted = [...new Set(files)]
    .map((file) => ({ file, ms: durations[file] ?? guess }))
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const bins = Array.from({ length: count }, () => ({ ms: 0, files: [] as string[] }));
  for (const { file, ms } of weighted) {
    const lightest = bins.reduce((best, bin, index) => (bin.ms < bins[best]!.ms ? index : best), 0);
    bins[lightest]!.ms += ms;
    bins[lightest]!.files.push(file);
  }
  return bins.map((bin) => bin.files);
};
