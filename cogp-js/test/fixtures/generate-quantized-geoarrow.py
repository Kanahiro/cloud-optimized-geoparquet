"""Small nested-overview fixtures, including holes, multipart geometries and shared LoDs."""
import json,struct
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
OUT=Path(__file__).resolve().parents[3]/'test-data'
coord=pa.struct([pa.field('x',pa.int32(),False),pa.field('y',pa.int32(),False)])
ring=[(0,0),(4,0),(4,4),(0,4),(0,0)]
hole=[(1,1),(1,2),(2,2),(2,1),(1,1)]
shapes={'LineString':([(0,0),(4,2),(8,0)],1,2),
 'MultiLineString':([[(0,0),(4,2)],[(5,1),(8,0)]],2,5),
 'Polygon':([ring,hole],2,3),
 'MultiPolygon':([[ring,hole],[[(6,0),(8,0),(8,2),(6,2),(6,0)]]],3,6)}
def wkb(v,kind):
 header=struct.pack('<BI',1,kind)
 if kind==2:return header+struct.pack('<I',len(v))+b''.join(struct.pack('<dd',*p) for p in v)
 if kind==3:return header+struct.pack('<I',len(v))+b''.join(struct.pack('<I',len(r))+b''.join(struct.pack('<dd',*p) for p in r) for r in v)
 return header+struct.pack('<I',len(v))+b''.join(wkb(p,2 if kind==5 else 3) for p in v)
def coords(v,depth,shift):
 if depth==1:return [{'x':x+shift,'y':y} for x,y in v]
 return [coords(x,depth-1,shift) for x in v]
def shifted(v,depth,shift):
 return [(x+shift,y) for x,y in v] if depth==1 else [shifted(x,depth-1,shift) for x in v]
for kind,(shape,depth,code) in shapes.items():
 typ=coord
 for _ in range(depth):typ=pa.list_(pa.field('element',typ,False))
 overview=pa.struct([pa.field('coarse',typ),pa.field('fine',typ)])
 geo={'version':'1.1.0','primary_column':'geometry','columns':{'geometry':{'encoding':'WKB','geometry_types':[kind],'covering':{'bbox':{k:['bounds',k] for k in ['xmin','ymin','xmax','ymax']}}}},'lod':{'levels':[{'row_group_end':0,'resolution':4,'lod':'coarse'},{'row_group_end':0,'resolution':2,'lod':'fine'},{'row_group_end':2,'resolution':1,'lod':'fine'}],'overviews':{'column':'render_geometry','encoding':'quantized_geoarrow','lods':{'coarse':{'geometry_type':kind,'scale':[2,2],'offset':[10,20]},'fine':{'geometry_type':kind,'scale':[1,1],'offset':[10,20]}}}}}
 schema=pa.schema([('id',pa.int32()),('geometry',pa.binary()),('overviews',pa.string()),('bounds',pa.struct([(k,pa.float64()) for k in ['xmin','ymin','xmax','ymax']])),pa.field('render_geometry',overview,False)],metadata={b'geo':json.dumps(geo).encode()})
 rows=[{'id':i,'geometry':wkb(shifted(shape,depth,i*100),code),'overviews':'ordinary attribute','bounds':{'xmin':i*100.,'ymin':0.,'xmax':i*100.+8,'ymax':4.},'render_geometry':{'coarse':coords(shape,depth,0) if i==0 else None,'fine':coords(shape,depth,i*100)}} for i in range(3)]
 table=pa.Table.from_pylist(rows,schema=schema)
 pq.write_table(table,OUT/f'quantized-geoarrow-{kind.lower()}.parquet',row_group_size=1,compression='zstd',use_dictionary=False,write_page_index=True,data_page_size=64,write_batch_size=1)
# The old encoding also supports an explicit column name.
f=pq.ParquetFile(OUT/'refinement.parquet');table=f.read();geo=json.loads(f.metadata.metadata[b'geo']);geo['lod']['overviews']['column']='render_geometry'
fields=[pa.field('render_geometry',x.type,x.nullable) if x.name=='overviews' else x for x in table.schema]
table=pa.Table.from_arrays(table.columns,schema=pa.schema(fields,metadata={b'geo':json.dumps(geo).encode()}))
with pq.ParquetWriter(OUT/'renamed-overview.parquet',table.schema,compression='zstd',write_page_index=True) as writer:
 offset=0
 for i in range(f.num_row_groups):
  n=f.metadata.row_group(i).num_rows;writer.write_table(table.slice(offset,n));offset+=n
