import type { Level } from './meta.js';

// LoD selection: pick the last level whose resolution >= target resolution.
// If no level satisfies that (target is coarser than the coarsest available),
// fall back to the first (coarsest) level.
export function selectLevelByResolution(levels: readonly Level[], targetResolution: number): number {
  if (levels.length === 0) {
    throw new Error('geo.lod has no levels');
  }
  let chosen = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]!.resolution >= targetResolution) chosen = i;
    else break;
  }
  return chosen === -1 ? 0 : chosen;
}
