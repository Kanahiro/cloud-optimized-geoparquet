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

export interface LodRange {
  start: number;
  end: number;
}

export function rowGroupRangeForLod(lods: readonly Lod[], lodIndex: number): LodRange {
  if (lodIndex < 0 || lodIndex >= lods.length) {
    throw new Error(`lodIndex ${lodIndex} out of range [0, ${lods.length})`);
  }
  const start = lodIndex === 0 ? 0 : lods[lodIndex - 1]!.row_group_end + 1;
  const end = lods[lodIndex]!.row_group_end;
  return { start, end };
}

// Row groups [0..lods[lodIndex].row_group_end], i.e. all row groups up to and
// including the selected LoD. This is what a renderer normally wants because
// finer LoDs build on coarser ones (each feature appears in exactly one LoD).
export function rowGroupPrefixForLod(lods: readonly Lod[], lodIndex: number): LodRange {
  if (lodIndex < 0 || lodIndex >= lods.length) {
    throw new Error(`lodIndex ${lodIndex} out of range [0, ${lods.length})`);
  }
  return { start: 0, end: lods[lodIndex]!.row_group_end };
}
