import { datasetName } from './format';

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

/** Show `url` in a preset select, adding an option for a file that is not a preset. */
export function selectPreset(select: HTMLSelectElement, url: string, addMissing = false): void {
  const known = Array.from(select.options).some((option) => option.value === url);
  if (!known && addMissing) select.add(new Option(datasetName(url), url));
  select.value = known || addMissing ? url : '';
}
