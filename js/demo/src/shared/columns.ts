/** Keep the user's order while ignoring whitespace, empty entries, and repeats. */
export function parseColumns(value: string): string[] {
  return [...new Set(value.split(',').map((column) => column.trim()).filter(Boolean))];
}
