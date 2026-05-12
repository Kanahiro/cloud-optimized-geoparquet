import {
  Binary,
  Bool,
  type DataType,
  Float64,
  Int64,
  Null,
  Table,
  TimestampMillisecond,
  Utf8,
  type Vector,
  vectorFromArray,
} from 'apache-arrow';

// Pivot row-oriented data into per-column arrays, preserving insertion order
// of the first row's keys.
function pivotRows(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown[]> {
  if (rows.length === 0) return {};
  const names = Object.keys(rows[0]!);
  const cols: Record<string, unknown[]> = {};
  for (const name of names) {
    const out = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) out[i] = rows[i]![name];
    cols[name] = out;
  }
  return cols;
}

// Pick an explicit Arrow DataType per column instead of relying on Arrow JS's
// internal inference. The bundled inferType throws on (a) all-null columns,
// (b) mixed bigint/number values (common when integer columns spill in and out
// of the safe-integer range across row groups), and (c) any value whose
// `typeof` isn't one of the handful it recognizes. Those cases happen
// intermittently across tiles, so we widen-then-coerce here.
function buildColumn(values: unknown[]): Vector {
  let firstBinary: Uint8Array | undefined;
  let hasNumber = false;
  let hasBigInt = false;
  let hasBoolean = false;
  let hasString = false;
  let hasDate = false;
  let hasOther = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (v instanceof Uint8Array) {
      if (!firstBinary) firstBinary = v;
      continue;
    }
    switch (typeof v) {
      case 'number': hasNumber = true; continue;
      case 'bigint': hasBigInt = true; continue;
      case 'boolean': hasBoolean = true; continue;
      case 'string': hasString = true; continue;
      case 'object':
        if (v instanceof Date) hasDate = true;
        else hasOther = true;
        continue;
      default:
        hasOther = true;
    }
  }

  if (firstBinary) {
    return vectorFromArray(values as (Uint8Array | null)[], new Binary());
  }
  if (hasOther) {
    // Lists/structs/etc. — defer to Arrow's inference, which knows how to walk
    // nested shapes. Arrow's inferType throws on heterogeneous nesting (mixed
    // array/object rows, structs with inconsistent shapes, etc.), so on
    // failure we fall back to a JSON-encoded Utf8 column to preserve the row.
    try {
      return vectorFromArray(values);
    } catch {
      const json = values.map((v) =>
        v === null || v === undefined ? null : safeJsonStringify(v),
      );
      return vectorFromArray(json as (string | null)[], new Utf8());
    }
  }
  const kinds = [hasNumber, hasBigInt, hasBoolean, hasString, hasDate].filter(Boolean).length;
  if (kinds === 0) {
    return vectorFromArray(values as null[], new Null());
  }
  if (hasNumber && hasBigInt && kinds === 2) {
    // Mixed numeric: coerce bigints to Number. Loses precision past 2^53 but
    // keeps the column readable; callers that need exact i64 should narrow
    // their column selection.
    const coerced = values.map((v) =>
      typeof v === 'bigint' ? Number(v) : (v as number | null | undefined),
    );
    return vectorFromArray(coerced as (number | null)[], new Float64());
  }
  if (hasNumber && kinds === 1) {
    return vectorFromArray(values as (number | null)[], new Float64());
  }
  if (hasBigInt && kinds === 1) {
    return vectorFromArray(values as (bigint | null)[], new Int64());
  }
  if (hasBoolean && kinds === 1) {
    return vectorFromArray(values as (boolean | null)[], new Bool());
  }
  if (hasString && kinds === 1) {
    return vectorFromArray(values as (string | null)[], new Utf8());
  }
  if (hasDate && kinds === 1) {
    return vectorFromArray(values as (Date | null)[], new TimestampMillisecond());
  }
  // Mixed primitive types we can't unify (e.g. string + number). Stringify so
  // the row count stays in sync with the rest of the table.
  const stringified = values.map((v) =>
    v === null || v === undefined ? null : String(v),
  );
  return vectorFromArray(stringified as (string | null)[], new Utf8());
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

export function rowsToArrowTable(rows: ReadonlyArray<Record<string, unknown>>): Table {
  if (rows.length === 0) {
    return new Table();
  }
  const pivoted = pivotRows(rows);
  const named: Record<string, Vector<DataType>> = {};
  for (const [name, vals] of Object.entries(pivoted)) {
    named[name] = buildColumn(vals);
  }
  return new Table(named);
}
