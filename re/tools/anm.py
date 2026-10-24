"""Mall Maniacs .anm parser (layout from Anm_Parse 0x433a90). Little-endian.
'ANM' + version(1|2)
u16 nObjects; nObjects x (u8 len, name)                 -> object names (resolved by name)
u16 nNodes;   nNodes   x (u8 len, name, u16 nodeIndex)  -> node bindings
u16 nFrames;  nFrames  x (u16 nCmds, cmds...)
  cmd 1|2: 3 x 4-byte value     (untyped copy in loader; [?] meaning, unused by shipped anims)
  cmd 3:   u16 obj, 3 x 4-byte  (object position [I]; unused by shipped anims)
  cmd 4:   u16 obj, i16 rx,ry,rz (object rotation [I]; unused by shipped anims)
  cmd 5:   u16 node, i16 rx,ry,rz (node rotation; 65536 = 360 deg; local matrix Ry(ry)*Rx(rx)*Rz(rz))
  cmd 6:   u16 node, i32 x,y,z  (node position; shipped anims set node 0: y = root height above floor
                                 e.g. 849 standing, 739..849 run bob; z = forward lean)"""
import os, struct, sys

def parse(path):
    d = open(path, 'rb').read(); assert d[:3] == b'ANM' and d[3] in (1, 2), 'not ANM'
    o = 4
    def u16():
        nonlocal o; v = struct.unpack_from('<H', d, o)[0]; o += 2; return v
    def pstr():
        nonlocal o; n = d[o]; s = d[o+1:o+1+n].decode('latin1'); o += 1 + n; return s
    objs = [pstr() for _ in range(u16())]
    nodes = []
    for _ in range(u16()):
        nm = pstr(); nodes.append((nm, u16()))
    frames = []
    for _ in range(u16()):
        cmds = []
        for _ in range(u16()):
            c = d[o]; o += 1
            if c in (1, 2): cmds.append((c, None, struct.unpack_from('<3i', d, o))); o += 12
            elif c in (3, 6): cmds.append((c, struct.unpack_from('<H', d, o)[0], struct.unpack_from('<3i', d, o+2))); o += 14
            elif c in (4, 5): cmds.append((c, struct.unpack_from('<H', d, o)[0], struct.unpack_from('<3h', d, o+2))); o += 8
            else: raise ValueError(f'unknown cmd {c} at {o-1}')
        frames.append(cmds)
    return dict(version=d[3], objects=objs, nodes=nodes, frames=frames, trailing=len(d) - o)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        a = parse(p)
        print(os.path.basename(p), 'v', a['version'], 'objs', a['objects'], 'nodes', len(a['nodes']), 'frames', len(a['frames']),
              'cmdtypes', sorted({c[0] for f in a['frames'] for c in f}), 'trailing', a['trailing'])
