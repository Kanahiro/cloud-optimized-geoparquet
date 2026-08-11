import type { GeometryOverview, Level } from './meta.js';

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

/**
 * Select one physical geometry column that is precise enough for `targetGsd`
 * and complete through `minimumLevel`. Callers doing lossy streaming may keep
 * the result on the finest complete overview instead of projecting raw WKB.
 */
export function selectGeometryColumnByGsd(
  overviews: readonly GeometryOverview[],
  targetGsd: number,
  minimumLevel: number,
  primaryColumn: string,
  fallbackToFinestOverview = false,
): string {
  // The primary column is the only representation available in a valid COGP
  // file without overviews. In particular, the bounded Line/Polygon policy
  // must not turn an optional optimization into a requirement.
  if (overviews.length === 0) return primaryColumn;

  const precise = overviews.find((overview) =>
    overview.level >= minimumLevel && overview.tolerance_meters <= targetGsd
  );
  if (precise) return precise.column;
  if (fallbackToFinestOverview) {
    for (let index = overviews.length - 1; index >= 0; index--) {
      const overview = overviews[index]!;
      if (overview.level >= minimumLevel) return overview.column;
    }
    throw new Error(
      `bounded rendering requires a geometry overview complete through level ${minimumLevel}`,
    );
  }
  return primaryColumn;
}
