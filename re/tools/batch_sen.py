"""Run sen2obj over every .SEN under original/ and report per-file stats. Usage: python -I batch_sen.py <original> <outroot>"""
import sys, os, glob, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sen2obj
orig, outroot = sys.argv[1:3]
for p in sorted(glob.glob(os.path.join(orig, '**', '*.SEN'), recursive=True)):
    rel = os.path.relpath(p, orig); d = os.path.dirname(p)
    try:
        s, st = sen2obj.export(p, d, os.path.join(outroot, os.path.dirname(rel).replace(os.sep, '_')))
        nm = sum(len(m['lods']) > 1 for m in s['meshes']); ng = max((len(m['lods'][0]['groups']) for m in s['meshes']), default=0)
        print(f"{rel:32} meshes={len(s['meshes']):4} objs={len(s['objs']):4} types={sorted({o['type'] for o in s['objs']})} {st} multiLOD={nm} maxGroups={ng}")
    except Exception as e:
        print(f"{rel:32} ERROR {type(e).__name__}: {e}")
