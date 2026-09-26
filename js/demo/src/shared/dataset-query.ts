/** Query parameter holding the COGP file URL, so a link reopens the same dataset. */
const DATASET_PARAM = 'url';

export function datasetFromQuery(): string | null {
  return new URLSearchParams(location.search).get(DATASET_PARAM)?.trim() || null;
}

/** Record the opened dataset in the query, keeping the map view in the hash. */
export function writeDatasetQuery(url: string): void {
  const next = new URL(location.href);
  next.searchParams.set(DATASET_PARAM, url);
  history.replaceState(null, '', next);
}

/** Select the preset for `url`, or the placeholder when it is not a preset. */
export function selectPreset(select: HTMLSelectElement, url: string): void {
  const known = Array.from(select.options).some((option) => option.value === url);
  select.value = known ? url : '';
}
