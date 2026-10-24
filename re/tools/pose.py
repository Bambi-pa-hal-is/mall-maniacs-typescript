"""Pose a character mesh from a .SEN with an .anm frame and write OBJ (validation of node/anim math).
Usage: python -I pose.py <characters.sen> <texdir> <mesh name> <file.anm> <frame> <outdir>"""
import os, sys, math, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sen2obj, anm

K = 2 * math.pi / 65536  # angle scale constant @0x44b788

def local_matrix(a, b, c):
    # FUN_0042f030: rows of Ry(b) * Rx(a) * Rz(c)
    sa, ca, sb, cb, sc, cc = math.sin(a*K), math.cos(a*K), math.sin(b*K), math.cos(b*K), math.sin(c*K), math.cos(c*K)
    return [[sc*sb*sa + cc*cb, cc*sb*sa - sc*cb, sb*ca],
            [sc*ca,            cc*ca,            -sa],
            [sc*cb*sa - cc*sb, cc*cb*sa + sc*sb, cb*ca]]

def mul(P, L): return [[sum(P[i][k]*L[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
def mv(M, v): return [sum(M[i][k]*v[k] for k in range(3)) for i in range(3)]

def main(sen, texdir, name, anmpath, frame, outdir):
    s = sen2obj.parse(sen); me = next(m for m in s['meshes'] if m['name'] == name)
    a = anm.parse(anmpath)
    rot = {}
    for f in a['frames'][:frame+1]:          # commands persist until overwritten [I]
        for c in f:
            if c[0] == 5: rot[c[1]] = c[2]
    nn = len(me['nodes']) + 1
    W = [None]*nn; P = [None]*nn
    W[0] = local_matrix(*rot.get(0, (0, 0, 0))); P[0] = [0, 0, 0]
    for i, nd in enumerate(me['nodes'], 1):
        p = nd['parent']
        W[i] = mul(W[p], local_matrix(*rot.get(i, (0, 0, 0))))
        P[i] = [x + y for x, y in zip(mv(W[p], nd['off']), P[p])]
    lod = me['lods'][0]
    vnode = [g[2] for g in lod['groups'] for _ in range(g[0])]
    os.makedirs(outdir, exist_ok=True)
    out = [f'mtllib pose.mtl']; vt = []; used = set()
    for vi, v in enumerate(lod['verts']):
        n = vnode[vi]; w = [x + y for x, y in zip(mv(W[n], v[:3]), P[n])]
        out.append(f'v {w[0]:.1f} {-w[1]:.1f} {-w[2]:.1f}')
    for idx, col, uv, fl in lod['prims']:
        if len(idx) < 3: continue
        if uv is not None:
            tex, _, _, *u = struct.unpack_from('<iHH8B', s['mapi'], uv*16); used.add(tex); out.append(f'usemtl t{tex}')
            ts = []
            for k in range(len(idx)): vt.append((u[2*k]/256, 1-u[2*k+1]/256)); ts.append(len(vt))
            out.append('f ' + ' '.join(f'{i+1}/{t}' for i, t in zip(idx, ts)))
    open(os.path.join(outdir, 'pose.obj'), 'w').write('\n'.join(out[:1] + [f'vt {x:.4f} {y:.4f}' for x, y in vt] + out[1:]))
    with open(os.path.join(outdir, 'pose.mtl'), 'w') as f:
        for t in sorted(used):
            nm = s['tnam'][t]; png = os.path.join(outdir, nm + '.png')
            if not os.path.exists(png): sen2obj.tpg2png(os.path.join(texdir, nm + '.TPG'), png)
            f.write(f'newmtl t{t}\nmap_Kd {nm}.png\n')
    print('nodes rotated', sorted(rot), 'cmd6', [c for c in a['frames'][frame] if c[0] == 6][:3])

if __name__ == '__main__':
    a = sys.argv; main(a[1], a[2], a[3], a[4], int(a[5]), a[6])
