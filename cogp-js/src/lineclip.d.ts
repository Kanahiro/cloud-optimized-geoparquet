declare module 'lineclip' {
  export type Position = [number, number];
  export type Bbox = [number, number, number, number];

  export function clipPolyline(
    points: Position[],
    bbox: Bbox,
    result?: Position[][],
  ): Position[][];

  export function clipPolygon(points: Position[], bbox: Bbox): Position[];
}
