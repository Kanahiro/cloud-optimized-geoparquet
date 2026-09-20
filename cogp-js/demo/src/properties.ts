export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Map) return Object.fromEntries(v);
      return v;
    });
  } catch {
    return String(value);
  }
}
