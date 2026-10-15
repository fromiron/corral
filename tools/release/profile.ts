export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string }; children?: number[] }[];
  samples?: number[];
  timeDeltas?: number[];
}

/** Aggregated sampled stacks; widths encode measured CPU time, not function call counts. */
export function flamegraph(profile: CpuProfile): string {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<number, number>();
  for (const [i, id] of (profile.samples ?? []).entries())
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
  const inclusive = new Map<number, number>();
  function duration(id: number): number {
    if (inclusive.has(id)) return inclusive.get(id) ?? 0;
    const total =
      (self.get(id) ?? 0) +
      (nodes.get(id)?.children ?? []).reduce((sum, child) => sum + duration(child), 0);
    inclusive.set(id, total);
    return total;
  }
  const root = profile.nodes[0];
  if (!root || !duration(root.id)) throw new Error('CPU profile contains no timed samples');
  const width = 1200;
  const scale = width / duration(root.id);
  const rows: string[] = [];
  let depth = 0;
  const escapeXml = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  function draw(id: number, x: number, level: number) {
    const node = nodes.get(id);
    const w = duration(id) * scale;
    if (!node || w < 0.25) return;
    depth = Math.max(depth, level);
    const label = node.callFrame.functionName || '(anonymous)';
    const title = escapeXml(`${label} · ${(duration(id) / 1000).toFixed(2)} ms sampled`);
    const y = 38 + level * 20;
    rows.push(
      `<g><title>${title}</title><rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="19" fill="hsl(${15 + (id % 40)} 78% 68%)" stroke="white" stroke-width="0.4"/>${w > 35 ? `<text x="${(x + 3).toFixed(2)}" y="${y + 14}" font-size="11">${escapeXml(label.slice(0, Math.floor(w / 7)))}</text>` : ''}</g>`,
    );
    let next = x;
    for (const child of node.children ?? []) {
      draw(child, next, level + 1);
      next += duration(child) * scale;
    }
  }
  draw(root.id, 0, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${(depth + 1) * 20 + 50}" role="img" aria-label="Sampled CPU flamegraph"><rect width="100%" height="100%" fill="white"/><text x="8" y="24" font-family="sans-serif">Corral production benchmark · CPU samples, idle included · ${(duration(root.id) / 1_000_000).toFixed(2)} seconds</text><g font-family="monospace">${rows.join('')}</g></svg>`;
}
