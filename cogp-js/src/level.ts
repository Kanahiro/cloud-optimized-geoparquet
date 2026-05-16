import type { Level } from './meta.js';

// SPEC §7: pick the last level whose gsd >= target_gsd.
// If no level satisfies that (target is coarser than the coarsest available),
// fall back to the first (coarsest) level.
export function selectLevelByGsd(levels: readonly Level[], targetGsd: number): number {
  if (levels.length === 0) {
    throw new Error('cogp metadata has no levels');
  }
  let chosen = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]!.gsd >= targetGsd) chosen = i;
    else break;
  }
  return chosen === -1 ? 0 : chosen;
}
