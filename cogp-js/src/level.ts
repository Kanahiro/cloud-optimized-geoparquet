import type { Level } from './meta.js';

// SPEC §7: pick the last level whose nominal ground resolution is at least
// the target. If none satisfies that, use the coarsest available level.
export function selectLevelByResolution(
  levels: readonly Level[],
  targetResolutionMeters: number,
): number {
  if (levels.length === 0) {
    throw new Error('cogp metadata has no levels');
  }
  let chosen = -1;
  for (let index = 0; index < levels.length; index++) {
    if (levels[index]!.resolution_meters >= targetResolutionMeters) chosen = index;
    else break;
  }
  return chosen === -1 ? 0 : chosen;
}
