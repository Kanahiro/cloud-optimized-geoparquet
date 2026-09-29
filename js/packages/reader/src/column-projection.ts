import type { OverviewFileMetadata } from './overview.js';

interface SchemaElement {
  name: string;
  num_children?: number;
  type?: string;
  repetition_type?: string;
  converted_type?: string;
  logical_type?: { type: string };
  [key: string]: unknown;
}

export interface SelectedColumn {
  /** The name requested by the caller and used in CogpBatch.columns. */
  name: string;
  /** Physical top-level column passed to hyparquet. */
  root: string;
  /** Field names to project physically; stops at the first indexed list. */
  projection: string[];
  /** Steps to take through the decoded top-level value. */
  access: Array<string | number>;
}

interface Node {
  element: SchemaElement;
  children: Node[];
}

interface Selection {
  whole: boolean;
  children: Map<string, Selection>;
}

function schemaTree(schema: readonly SchemaElement[]): Node {
  let index = 0;
  const visit = (): Node => {
    const element = schema[index++];
    if (!element) throw new Error('parquet schema is truncated');
    const children: Node[] = [];
    for (let i = 0; i < (element.num_children ?? 0); i++) children.push(visit());
    return { element, children };
  };
  const root = visit();
  if (index !== schema.length) throw new Error('parquet schema has trailing elements');
  return root;
}

function isPlainStruct(node: Node): boolean {
  return node.children.length > 0 && node.element.type === undefined
    && node.element.repetition_type !== 'REPEATED'
    && node.element.converted_type === undefined && node.element.logical_type === undefined;
}

function mapValue(node: Node): Node | undefined {
  if (node.element.converted_type !== 'MAP' || node.children.length !== 1) return undefined;
  const entries = node.children[0]!;
  if (entries.element.repetition_type !== 'REPEATED' || entries.children.length !== 2
    || !entries.children.some(child => child.element.name === 'key')) return undefined;
  return entries.children.find(child => child.element.name === 'value');
}

function listElement(node: Node): Node | undefined {
  if (node.element.converted_type !== 'LIST' && node.element.logical_type?.type !== 'LIST') return undefined;
  if (node.children.length !== 1) return undefined;
  const repeated = node.children[0]!;
  if (repeated.element.repetition_type !== 'REPEATED') return undefined;
  // Three-level lists have one element child; two-level lists use the repeated node.
  if (repeated.children.length > 1) return repeated;
  return repeated.children[0] ?? repeated;
}

/** Resolve struct fields, map keys and list indices against the physical schema before any column I/O. */
export function selectColumns(schema: readonly SchemaElement[], names: readonly string[]): SelectedColumn[] {
  const roots = schemaTree(schema).children;
  return names.map(name => {
    // A literal top-level name containing dots or brackets takes precedence.
    const exact = roots.find(node => node.element.name === name);
    if (exact) return { name, root: name, projection: [], access: [] };
    let node: Node | undefined;
    let root = '';
    const projection: string[] = [];
    const access: Array<string | number> = [];
    let indexed = false;
    for (const [i, part] of name.split('.').entries()) {
      const match = /^([^.[\]]+)((?:\[\d+\])*)$/.exec(part);
      if (!match) throw new Error(`invalid parquet column path: ${name}`);
      const field = match[1]!;
      if (i === 0) {
        node = roots.find(candidate => candidate.element.name === field);
        if (!node) throw new Error(`parquet column not found: ${name}`);
        root = field;
      } else {
        const value = node && mapValue(node);
        if (value) {
          // Map lookup needs both the physical key and value leaves, so keep
          // the map whole and select its logical key after decoding.
          access.push(field);
          indexed = true;
          node = value;
        } else if (!node || !isPlainStruct(node)) {
          throw new Error(`parquet column path crosses a non-struct field: ${name}`);
        } else {
          node = node.children.find(candidate => candidate.element.name === field);
          if (!node) throw new Error(`parquet column not found: ${name}`);
          access.push(field);
          if (!indexed) projection.push(field);
        }
      }
      for (const indexMatch of match[2]!.matchAll(/\[(\d+)\]/g)) {
        const index = Number(indexMatch[1]);
        if (!Number.isSafeInteger(index)) throw new Error(`invalid parquet list index: ${name}`);
        const element = listElement(node!);
        if (!element) throw new Error(`parquet column is not a list: ${name}`);
        access.push(index);
        indexed = true;
        node = element;
      }
    }
    return { name, root, projection, access };
  });
}

/** Keep only requested physical leaves beneath partially selected structs. */
export function projectNestedColumns<T extends OverviewFileMetadata>(metadata: T, selected: readonly SelectedColumn[]): T {
  const selections = new Map<string, Selection>();
  for (const column of selected) {
    let rootSelection = selections.get(column.root);
    if (!rootSelection) {
      rootSelection = { whole: false, children: new Map() };
      selections.set(column.root, rootSelection);
    }
    let selection: Selection = rootSelection;
    if (column.projection.length === 0) {
      selection.whole = true;
      continue;
    }
    for (const child of column.projection) {
      let next: Selection | undefined = selection.children.get(child);
      if (!next) selection.children.set(child, next = { whole: false, children: new Map() });
      selection = next;
    }
    selection.whole = true;
  }
  const partial = new Map([...selections].filter(([, selection]) => !selection.whole));
  if (partial.size === 0) return metadata;

  const root = schemaTree(metadata.schema);
  const keep = (node: Node, selection: Selection): Node => {
    if (selection.whole) return node;
    return {
      element: { ...node.element, num_children: selection.children.size },
      children: node.children
        .filter(child => selection.children.has(child.element.name))
        .map(child => keep(child, selection.children.get(child.element.name)!)),
    };
  };
  const children = root.children.map(node => {
    const selection = partial.get(node.element.name);
    return selection ? keep(node, selection) : node;
  });
  const projected: SchemaElement[] = [];
  const leaves = new Set<string>();
  const flatten = (node: Node, path: string[]): void => {
    projected.push(node.element);
    if (node.children.length === 0) leaves.add([...path, node.element.name].join('.'));
    else for (const child of node.children) flatten(child, [...path, node.element.name]);
  };
  projected.push(root.element);
  for (const child of children) flatten(child, []);
  const row_groups = metadata.row_groups.map(rowGroup => ({
    ...rowGroup,
    columns: rowGroup.columns.filter(chunk => {
      const path = chunk.meta_data?.path_in_schema;
      return !path || !partial.has(path[0]!) || leaves.has(path.join('.'));
    }),
  }));
  return { ...metadata, schema: projected, row_groups } as T;
}
