import { clipPolygon, clipPolyline } from 'lineclip';

export type Position = [number, number];
export type ClipBbox = [number, number, number, number];

export function clipPolygonRing(input: Position[], bbox: ClipBbox): Position[] {
  if (input.length < 3) return [];
  return normalizePath(clipPolygon(input, bbox), true);
}

export function clipLineString(input: Position[], bbox: ClipBbox): Position[][] {
  if (input.length < 2) return [];
  const output: Position[][] = [];
  for (const part of clipPolyline(input, bbox)) {
    const normalized = normalizePath(part, false);
    if (normalized.length >= 2) output.push(normalized);
  }
  return output;
}

export function pointInBbox(x: number, y: number, bbox: ClipBbox): boolean {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

function normalizePath(input: Position[], closed: boolean): Position[] {
  const output: Position[] = [];
  for (const coordinate of input) {
    const point: Position = [Math.round(coordinate[0]), Math.round(coordinate[1])];
    const previous = output[output.length - 1];
    if (previous?.[0] === point[0] && previous[1] === point[1]) continue;
    output.push(point);
  }
  if (
    closed
    && output.length >= 2
    && output[0]![0] === output[output.length - 1]![0]
    && output[0]![1] === output[output.length - 1]![1]
  ) output.pop();
  if (closed && (output.length < 3 || signedAreaTwice(output) === 0)) return [];
  return output;
}

function signedAreaTwice(coordinates: Position[]): number {
  let area = 0;
  let previous = coordinates[coordinates.length - 1]!;
  for (const coordinate of coordinates) {
    area += previous[0] * coordinate[1] - coordinate[0] * previous[1];
    previous = coordinate;
  }
  return area;
}
