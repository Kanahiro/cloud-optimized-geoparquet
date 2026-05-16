import type { Lod } from './meta.js';

// SPEC §7: pick the last LoD whose gsd >= target_gsd.
// If no LoD satisfies that (target is coarser than the coarsest available),
// fall back to the first (coarsest) LoD.
export function selectLodByGsd(lods: readonly Lod[], targetGsd: number): number {
  if (lods.length === 0) {
    throw new Error('cogp metadata has no LoDs');
  }
  let chosen = -1;
  for (let i = 0; i < lods.length; i++) {
    if (lods[i]!.gsd >= targetGsd) chosen = i;
    else break;
  }
  return chosen === -1 ? 0 : chosen;
}
