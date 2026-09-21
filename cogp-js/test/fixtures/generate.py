"""Regenerate the small reader fixtures with PyArrow (not needed to run tests)."""
import json
import struct
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

out = Path(__file__).parent
xs = [float(i if i < 4 else 100 + i) for i in range(16)] + [float(140 + i / 10) for i in range(32)]
schema = pa.schema([
    ('id', pa.int32()),
    ('bounds', pa.struct([(n, pa.float64()) for n in ['xmin', 'ymin', 'xmax', 'ymax']])),
    ('geometry', pa.binary()),
    ('bbox', pa.string()),  # A normal attribute: covering names must come from metadata.
])
geo = {'version': '1.1.0', 'primary_column': 'geometry', 'columns': {
    'geometry': {'encoding': 'WKB', 'geometry_types': ['Point'], 'covering': {'bbox': {
        n: ['bounds', n] for n in ['xmin', 'ymin', 'xmax', 'ymax']}}}},
    'lod': {'levels': [{'row_group_end': 2, 'resolution': 1.0}]}}
rows = [{'id': i, 'bounds': {'xmin': x, 'ymin': 0., 'xmax': x, 'ymax': 0.},
         'geometry': struct.pack('<BIdd', 1, 1, x, 0.), 'bbox': f'attribute-{i}'} for i, x in enumerate(xs)]
for name, indexes, stats, covering in [('indexed', True, True, True), ('no-index', False, True, True),
                                      ('no-statistics', False, False, True), ('no-covering', True, True, False)]:
    metadata = json.loads(json.dumps(geo))
    if not covering:
        del metadata['columns']['geometry']['covering']
    table = pa.Table.from_pylist(rows, schema=schema.with_metadata({'geo': json.dumps(metadata)}))
    pq.write_table(table, out / f'{name}.parquet', row_group_size=16, data_page_size=64,
                   write_batch_size=4, compression='NONE', use_dictionary=False,
                   write_page_index=indexes, write_statistics=stats)
