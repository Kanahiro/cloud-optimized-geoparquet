/**
 * Minimal Arrow IPC stream writer: one schema and one uncompressed record
 * batch, without dictionaries. The FlatBuffers metadata is written front to
 * back, so every referenced object follows the offset that points to it.
 */

export type ArrowType =
  | { id: 'int'; bitWidth: 8 | 16 | 32 | 64; signed: boolean }
  | { id: 'float'; precision: 'single' | 'double' }
  | { id: 'utf8' }
  | { id: 'binary' }
  | { id: 'bool' }
  | { id: 'timestamp'; unit: 'millisecond'; timezone?: string }
  | { id: 'list' }
  | { id: 'fixedSizeList'; size: number };

/** A field together with its record batch data; buffers follow the Arrow layout for `type`. */
export interface ArrowColumn {
  name: string;
  nullable: boolean;
  type: ArrowType;
  metadata?: Readonly<Record<string, string>>;
  length: number;
  nullCount: number;
  buffers: ArrayBufferView[];
  children?: ArrowColumn[];
}

const EMPTY = new Uint8Array(0);
const textEncoder = new TextEncoder();

/** An absent validity bitmap, meaning every value is valid. */
export const NO_VALIDITY: ArrayBufferView = EMPTY;

/** LSB-ordered bitmap of `bit`, as used by validity and boolean buffers. */
export function packBits(length: number, bit: (index: number) => boolean): Uint8Array {
  const bitmap = new Uint8Array((length + 7) >> 3);
  for (let i = 0; i < length; i++) if (bit(i)) bitmap[i >> 3]! |= 1 << (i & 7);
  return bitmap;
}

/** Validity bitmap of `isValid`, or `NO_VALIDITY` when every value is valid. */
export function validityBitmap(length: number, isValid: (index: number) => boolean): { bitmap: ArrayBufferView; nullCount: number } {
  let nullCount = 0;
  const bitmap = packBits(length, i => isValid(i) || (nullCount++, false));
  return { bitmap: nullCount ? bitmap : NO_VALIDITY, nullCount };
}

/** Encode `columns` as an Arrow IPC stream with a single record batch of `length` rows. */
export function writeIpcStream(columns: readonly ArrowColumn[], length: number): ArrayBuffer {
  const schema = message(1, {
    table: [i16(0), { vector: columns.map(fieldTable) }],
  }, 0);

  const nodes: ArrowColumn[] = [];
  const visit = (column: ArrowColumn): void => {
    nodes.push(column);
    column.children?.forEach(visit);
  };
  columns.forEach(visit);
  const buffers = nodes.flatMap(node => node.buffers);
  const nodeStructs = new DataView(new ArrayBuffer(nodes.length * 16));
  nodes.forEach((node, i) => {
    nodeStructs.setBigInt64(i * 16, BigInt(node.length), true);
    nodeStructs.setBigInt64(i * 16 + 8, BigInt(node.nullCount), true);
  });
  const bufferStructs = new DataView(new ArrayBuffer(buffers.length * 16));
  let bodyLength = 0;
  buffers.forEach((buffer, i) => {
    bufferStructs.setBigInt64(i * 16, BigInt(bodyLength), true);
    bufferStructs.setBigInt64(i * 16 + 8, BigInt(buffer.byteLength), true);
    bodyLength += align(buffer.byteLength, 8);
  });
  const batch = message(3, {
    table: [
      i64(length),
      { structs: new Uint8Array(nodeStructs.buffer), count: nodes.length },
      { structs: new Uint8Array(bufferStructs.buffer), count: buffers.length },
    ],
  }, bodyLength);

  const framed = (metadata: Uint8Array): number => 8 + align(metadata.byteLength, 8);
  const out = new Uint8Array(framed(schema) + framed(batch) + bodyLength + 8);
  const view = new DataView(out.buffer);
  let at = 0;
  const writeMessage = (metadata: Uint8Array): void => {
    const padded = align(metadata.byteLength, 8);
    view.setUint32(at, 0xffff_ffff, true);
    view.setInt32(at + 4, padded, true);
    out.set(metadata, at + 8);
    at += 8 + padded;
  };
  writeMessage(schema);
  writeMessage(batch);
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), at);
    at += align(buffer.byteLength, 8);
  }
  // End-of-stream marker.
  view.setUint32(at, 0xffff_ffff, true);
  view.setInt32(at + 4, 0, true);
  return out.buffer;
}

/** Message with MetadataVersion V5. */
function message(headerType: 1 | 3, header: FbTable, bodyLength: number): Uint8Array {
  return new FlatBufferWriter().finish({ table: [i16(4), u8(headerType), header, i64(bodyLength)] });
}

function fieldTable(column: ArrowColumn): FbTable {
  const [typeId, type] = typeTable(column.type);
  const metadata = Object.entries(column.metadata ?? {});
  return {
    table: [
      column.name,
      u8(column.nullable ? 1 : 0),
      u8(typeId),
      type,
      undefined,
      // Arrow C++ rejects fields without a children vector, even an empty one.
      { vector: (column.children ?? []).map(fieldTable) },
      metadata.length ? { vector: metadata.map(([key, value]) => ({ table: [key, value] })) } : undefined,
    ],
  };
}

function typeTable(type: ArrowType): [number, FbTable] {
  switch (type.id) {
    case 'int': return [2, { table: [i32(type.bitWidth), u8(type.signed ? 1 : 0)] }];
    case 'float': return [3, { table: [i16(type.precision === 'single' ? 1 : 2)] }];
    case 'binary': return [4, { table: [] }];
    case 'utf8': return [5, { table: [] }];
    case 'bool': return [6, { table: [] }];
    case 'timestamp': return [10, { table: [i16(1), type.timezone] }];
    case 'list': return [12, { table: [] }];
    case 'fixedSizeList': return [16, { table: [i32(type.size)] }];
  }
}

interface FbScalar { size: 1 | 2 | 4 | 8; value: number }
interface FbTable { table: (FbScalar | FbNode | undefined)[] }
interface FbVector { vector: FbNode[] }
/** Vector of 8-byte aligned structs, already encoded little-endian. */
interface FbStructs { structs: Uint8Array; count: number }
type FbNode = FbTable | FbVector | FbStructs | string;

const u8 = (value: number): FbScalar => ({ size: 1, value });
const i16 = (value: number): FbScalar => ({ size: 2, value });
const i32 = (value: number): FbScalar => ({ size: 4, value });
const i64 = (value: number): FbScalar => ({ size: 8, value });

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

class FlatBufferWriter {
  private bytes = new Uint8Array(512);
  private view = new DataView(this.bytes.buffer);
  private pos = 0;

  finish(root: FbTable): Uint8Array {
    this.pos = 4;
    const table = this.table(root);
    this.view.setUint32(0, table, true);
    return this.bytes.slice(0, this.pos);
  }

  private node(node: FbNode): number {
    if (typeof node === 'string') return this.string(node);
    if ('table' in node) return this.table(node);
    if ('vector' in node) return this.vector(node.vector);
    return this.structs(node);
  }

  private table({ table: fields }: FbTable): number {
    // Place larger fields first so each is naturally aligned within the table.
    const slots = fields
      .map((field, id) => ({ field, id, size: field === undefined ? 0 : isScalar(field) ? field.size : 4 }))
      .filter(slot => slot.field !== undefined)
      .sort((a, b) => b.size - a.size);
    const at = new Array<number>(fields.length).fill(0);
    let size = 4;
    for (const slot of slots) {
      size = align(size, slot.size);
      at[slot.id] = size;
      size += slot.size;
    }
    const count = slots.length ? Math.max(...slots.map(slot => slot.id)) + 1 : 0;

    this.pad(2);
    const vtable = this.pos;
    this.reserve(4 + 2 * count);
    this.view.setUint16(vtable, 4 + 2 * count, true);
    this.view.setUint16(vtable + 2, size, true);
    for (let id = 0; id < count; id++) this.view.setUint16(vtable + 4 + 2 * id, at[id]!, true);
    this.pos += 4 + 2 * count;

    this.pad(Math.max(4, ...slots.map(slot => slot.size)));
    const start = this.pos;
    this.reserve(size);
    this.view.setInt32(start, start - vtable, true);
    const children: [number, FbNode][] = [];
    for (const { field, id } of slots) {
      const offset = start + at[id]!;
      if (isScalar(field!)) this.scalar(offset, field);
      else children.push([offset, field as FbNode]);
    }
    this.pos = start + size;
    for (const [offset, child] of children) this.patch(offset, this.node(child));
    return start;
  }

  private vector(items: readonly FbNode[]): number {
    this.pad(4);
    const start = this.pos;
    this.reserve(4 + 4 * items.length);
    this.view.setUint32(start, items.length, true);
    this.pos += 4 + 4 * items.length;
    items.forEach((item, i) => {
      const offset = start + 4 + 4 * i;
      this.patch(offset, this.node(item));
    });
    return start;
  }

  private structs({ structs, count }: FbStructs): number {
    // The length prefix sits just before the 8-byte aligned elements.
    this.pos = align(this.pos + 4, 8) - 4;
    const start = this.pos;
    this.reserve(4 + structs.byteLength);
    this.view.setUint32(start, count, true);
    this.bytes.set(structs, start + 4);
    this.pos += 4 + structs.byteLength;
    return start;
  }

  private string(value: string): number {
    const encoded = textEncoder.encode(value);
    this.pad(4);
    const start = this.pos;
    this.reserve(4 + encoded.byteLength + 1);
    this.view.setUint32(start, encoded.byteLength, true);
    this.bytes.set(encoded, start + 4);
    this.pos += 4 + encoded.byteLength + 1; // NUL terminator
    return start;
  }

  /** Point the uoffset at `offset` to `target`; resolve `target` first, as writing it may grow the buffer. */
  private patch(offset: number, target: number): void {
    this.view.setUint32(offset, target - offset, true);
  }

  private scalar(offset: number, { size, value }: FbScalar): void {
    if (size === 1) this.view.setUint8(offset, value);
    else if (size === 2) this.view.setInt16(offset, value, true);
    else if (size === 4) this.view.setInt32(offset, value, true);
    else this.view.setBigInt64(offset, BigInt(value), true);
  }

  private pad(to: number): void {
    this.pos = align(this.pos, to);
  }

  /** Ensure `extra` bytes from `pos`; new bytes are zero, so padding needs no writes. */
  private reserve(extra: number): void {
    const required = this.pos + extra;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength * 2;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}

function isScalar(field: FbScalar | FbNode): field is FbScalar {
  return typeof field === 'object' && 'size' in field;
}
