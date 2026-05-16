declare module 'vt-pbf' {
  interface Options {
    version?: number;
    extent?: number;
  }

  interface Encoder {
    fromGeojsonVt(layers: Record<string, unknown>, options?: Options): Uint8Array;
  }

  const vtpbf: Encoder;
  export default vtpbf;
}
