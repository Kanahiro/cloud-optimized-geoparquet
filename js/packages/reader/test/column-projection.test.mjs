import assert from 'node:assert/strict';
import test from 'node:test';
import { projectNestedColumns, selectColumns } from '../dist/column-projection.js';

test('nested struct projection keeps one leaf and updates ancestor child counts', () => {
  const schema = [
    { name: 'schema', num_children: 2 },
    { name: 'building', num_children: 2, repetition_type: 'OPTIONAL' },
    { name: 'details', num_children: 2, repetition_type: 'OPTIONAL' },
    { name: 'height', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
    { name: 'width', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
    { name: 'name', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
    { name: 'id', type: 'INT32', repetition_type: 'REQUIRED' },
  ];
  const paths = ['building.details.height', 'building.details.width', 'building.name', 'id'];
  const metadata = {
    schema,
    row_groups: [{ columns: paths.map(path => ({ meta_data: { path_in_schema: path.split('.') } })) }],
  };
  const selected = selectColumns(schema, ['building.details.height', 'id']);
  const projected = projectNestedColumns(metadata, selected);
  assert.deepEqual(projected.schema.map(node => [node.name, node.num_children]), [
    ['schema', 2], ['building', 1], ['details', 1], ['height', undefined], ['id', undefined],
  ]);
  assert.deepEqual(projected.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.')),
    ['building.details.height', 'id']);
  assert.deepEqual(metadata.schema, schema);
  assert.deepEqual(metadata.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.')), paths);
  assert.strictEqual(projectNestedColumns(metadata, selectColumns(schema, ['building', 'id'])), metadata);
});

test('an indexed list keeps its physical subtree while pruning sibling struct fields', () => {
  const schema = [
    { name: 'schema', num_children: 1 },
    { name: 'struct', num_children: 2, repetition_type: 'OPTIONAL' },
    { name: 'array', num_children: 1, repetition_type: 'OPTIONAL', converted_type: 'LIST' },
    { name: 'list', num_children: 1, repetition_type: 'REPEATED' },
    { name: 'element', num_children: 2, repetition_type: 'REQUIRED' },
    { name: 'height', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
    { name: 'width', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
    { name: 'unused', type: 'INT32', repetition_type: 'OPTIONAL' },
  ];
  const paths = ['struct.array.list.element.height', 'struct.array.list.element.width', 'struct.unused'];
  const metadata = {
    schema,
    row_groups: [{ columns: paths.map(path => ({ meta_data: { path_in_schema: path.split('.') } })) }],
  };
  const selected = selectColumns(schema, ['struct.array[1].height']);
  assert.deepEqual(selected[0].access, ['array', 1, 'height']);
  const projected = projectNestedColumns(metadata, selected);
  assert.deepEqual(projected.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.')),
    paths.slice(0, 2));
  const logicalSchema = schema.map(node => node.name === 'array'
    ? { ...node, converted_type: undefined, logical_type: { type: 'LIST' } } : node);
  assert.deepEqual(selectColumns(logicalSchema, ['struct.array[1].height'])[0].access,
    ['array', 1, 'height']);
});
