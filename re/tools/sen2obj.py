"""Mall Maniacs .SEN (REV2) decoder -> Wavefront OBJ + MTL (+ PNG textures).
Layout derived from maniac.exe: Sen_Load 0x432320, Sen_FixupMesh 0x4320f0,
Spitfire_DrawObject 0x42f8c0, DrawPrimGroup 0x42e940, GetVertexFrame 0x4300d0.
Usage: python -I sen2obj.py <scene.sen> <texdir> <outdir>   (reads only; writes to outdir)"""
import os, struct, sys, zlib, math

def chunks(d):
    assert d[:4] == b'REV2'
    off, out = 8, {}
    while off + 8 <= len(d):
        t = d[off:off+4].decode(); s = struct.unpack_from('<I', d, off+4)[0]
        out.setdefault(t, []).append(d[off+8:off+8+s]); off += 8 + s
    return out

def cstrs(b): return [s.decode('latin1') for s in b.split(b'\0')[:-1]] if b else []

def parse(path):
    c = chunks(open(path, 'rb').read())
    subo = c.get('SUBO', [b''])[0]; mapi = c.get('MAPI', [b''])[0]; cols = c.get('COLS', [b''])[0]
    tnam = cstrs(c.get('TNAM', [b''])[0]); onamb = c.get('ONAM', [b''])[0]
    meshes = []
    for name, m in zip(c['NAME'], c['MESH']):
        h = struct.unpack_from('<13i', m)
        nlod = h[1]; lods = []
        for li in range(nlod):
            lo = h[5] + 8 + li * 48
            r = struct.unpack_from('<12i', m, lo - 8 + 8)  # record fields relative to lod base
            base = lo - 8  # 'iVar10' in renderer
            f = lambda o: struct.unpack_from('<i', m, base + o)[0]
            nverts, vptr = f(4), f(8)
            nprim, plist, ngrp, gtab = f(0x14), f(0x18), f(0x1c), f(0x20)
            verts = [struct.unpack_from('<3h2B', m, vptr + i*8) for i in range(nverts)]
            groups = [struct.unpack_from('<3i', m, gtab + i*12) for i in range(ngrp)]
            prims = []
            for pi in range(nprim):
                p = struct.unpack_from('<i', m, plist + pi*4)[0]
                cnt, vpp = subo[p], subo[p+1]
                flags, _, stride = struct.unpack_from('<HHH', subo, p+2)
                stride &= 0xff
                hascol, hasuv = (flags >> 3) & 1, (flags >> 2) & 1
                q = p + 8
                for _ in range(cnt):
                    idx = list(subo[q:q+vpp])
                    col = struct.unpack_from('<H', subo, q+4)[0] if hascol else None
                    uv = struct.unpack_from('<H', subo, q+4+2*hascol)[0] if hasuv else None
                    prims.append((idx, col, uv, flags)); q += stride * 2
            lods.append(dict(dist=f(0), verts=verts, groups=groups, prims=prims))
        # Node hierarchy (characters): hdr+0x08 count, +0x0C int16[4] offset from parent, +0x10 byte parent (0 = root).
        # Entry i describes node i+1; node 0 is the object root.
        nodes = [dict(off=struct.unpack_from('<3h', m, h[3] + i*8), parent=m[h[4] + i*4]) for i in range(h[2])]
        meshes.append(dict(name=name.split(b'\0')[0].decode('latin1'), hdr=h, lods=lods, nodes=nodes))
    objs = []
    obji = c.get('OBJI', [b''])[0]
    for i in range(len(obji) // 32):
        ni, typ, parent, x, y, z, rx, ry, rz, mi = struct.unpack_from('<3i3f4h', obji, i*32)
        # OBJI+0 is a byte offset into ONAM (Sen_Load walks the string block), not a list index.
        nm = onamb[ni:onamb.index(b'\0', ni)].decode('latin1') if 0 <= ni < len(onamb) else '?'
        objs.append(dict(name=nm, type=typ, parent=parent,
                         pos=(x, y, z), rot=(rx, ry, rz), mesh=mi))
    return dict(meshes=meshes, objs=objs, tnam=tnam, mapi=mapi, cols=cols)

def tpg2png(src, dst):
    d = open(src, 'rb').read(); pal = d[65536:65536+1024]
    raw = b''.join(b'\0' + bytes(b for i in d[y*256:(y+1)*256] for b in pal[i*4:i*4+3]) for y in range(256))
    ch = lambda t, x: struct.pack('>I', len(x)) + t + x + struct.pack('>I', zlib.crc32(t + x) & 0xffffffff)
    open(dst, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0))
                          + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))

def rot(v, r):
    a = [x * 2 * math.pi / 65536 for x in r]  # [I] 16-bit angles
    x, y, z = v
    cy, sy = math.cos(a[1]), math.sin(a[1])
    x, z = x * cy + z * sy, -x * sy + z * cy
    return x, y, z

def export(scene, texdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    s = parse(scene); base = os.path.splitext(os.path.basename(scene))[0].lower()
    used = set(); lines = [f'mtllib {base}.mtl']; vt = []; nv = 0; stats = dict(prims=0, bad=0)
    def mapi(i): return struct.unpack_from('<iHH8B', s['mapi'], i*16)
    for o in s['objs']:
        if o['type'] != 1 or not (0 <= o['mesh'] < len(s['meshes'])): continue
        me = s['meshes'][o['mesh']]; lod = me['lods'][0]
        lines.append(f"o {o['name']}")
        npos = [(0, 0, 0)]  # bind-pose world offset per node (translation only)
        for nd in me['nodes']:
            p = npos[nd['parent']] if nd['parent'] < len(npos) else (0, 0, 0)
            npos.append(tuple(a + b for a, b in zip(p, nd['off'])))
        vnode = [g[2] for g in lod['groups'] for _ in range(g[0])]
        for vi, vx in enumerate(lod['verts']):
            no = npos[vnode[vi]] if vi < len(vnode) and vnode[vi] < len(npos) else (0, 0, 0)
            x, y, z = rot([a + b for a, b in zip(vx[:3], no)], o['rot'])
            lines.append(f"v {x+o['pos'][0]:.1f} {-(y+o['pos'][1]):.1f} {-(z+o['pos'][2]):.1f}")  # engine is Y-down; rotate 180 deg about X
        for idx, col, uv, fl in lod['prims']:
            stats['prims'] += 1
            if len(idx) < 3: continue
            if max(idx) >= len(lod['verts']): stats['bad'] += 1; continue
            if uv is not None and uv * 16 < len(s['mapi']):
                tex, _, _, *u = mapi(uv); used.add(tex); lines.append(f'usemtl t{tex}')
                ts = []
                for k in range(len(idx)):
                    vt.append((u[k*2] / 256, 1 - u[k*2+1] / 256)); ts.append(len(vt))
                lines.append('f ' + ' '.join(f'{nv+i+1}/{t}' for i, t in zip(idx, ts)))
            else:
                lines.append('usemtl flat'); lines.append('f ' + ' '.join(str(nv+i+1) for i in idx))
        nv += len(lod['verts'])
    with open(os.path.join(outdir, base + '.obj'), 'w') as f:
        f.write('\n'.join(lines[:1] + [f'vt {a:.4f} {b:.4f}' for a, b in vt] + lines[1:]))
    with open(os.path.join(outdir, base + '.mtl'), 'w') as f:
        f.write('newmtl flat\nKd 0.7 0.7 0.7\n')
        for t in sorted(used):
            nm = s['tnam'][t] if t < len(s['tnam']) else f'T{t}'
            src = os.path.join(texdir, nm + '.TPG')
            if os.path.exists(src): tpg2png(src, os.path.join(outdir, nm + '.png'))
            f.write(f'newmtl t{t}\nKd 1 1 1\nmap_Kd {nm}.png\n')
    return s, stats

if __name__ == '__main__':
    s, st = export(*sys.argv[1:4])
    print('meshes', len(s['meshes']), 'objs', len(s['objs']), 'types', sorted({o['type'] for o in s['objs']}), st)
