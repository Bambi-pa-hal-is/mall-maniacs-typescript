"""Tiny software rasterizer to preview an exported OBJ (textured, z-buffered). For validation only.
Usage: python -I objpreview.py <file.obj> <out.png> <eye x,y,z> <target x,y,z> [w h]"""
import sys, os, struct, zlib, math
import numpy as np

def readpng(p):
    d = open(p, 'rb').read(); off = 8; idat = b''
    while off < len(d):
        n = struct.unpack('>I', d[off:off+4])[0]; t = d[off+4:off+8]
        if t == b'IHDR': w, h = struct.unpack('>II', d[off+8:off+16])
        if t == b'IDAT': idat += d[off+8:off+8+n]
        off += 12 + n
    raw = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, w*3+1)
    return raw[:, 1:].reshape(h, w, 3)  # filter type 0 only (our writer)

def main(obj, out, eye, tgt, W=640, H=480):
    base = os.path.dirname(obj); V=[]; T=[]; faces=[]; mtl={}; cur=None; texmap={}
    for l in open(obj):
        p = l.split()
        if not p: continue
        if p[0]=='mtllib':
            m=None
            for q in open(os.path.join(base,p[1])):
                q=q.split()
                if q and q[0]=='newmtl': m=q[1]
                if q and q[0]=='map_Kd': texmap[m]=q[1]
        elif p[0]=='v': V.append([float(x) for x in p[1:4]])
        elif p[0]=='vt': T.append([float(x) for x in p[1:3]])
        elif p[0]=='usemtl': cur=p[1]
        elif p[0]=='f':
            idx=[[int(y) if y else 0 for y in x.split('/')]+[0] for x in p[1:]]
            for k in range(1,len(idx)-1): faces.append((cur,[idx[0],idx[k],idx[k+1]]))
    V=np.array(V); T=np.array(T) if T else np.zeros((1,2))
    tex={m:readpng(os.path.join(base,f)) for m,f in texmap.items() if os.path.exists(os.path.join(base,f))}
    eye=np.array(eye,float); tgt=np.array(tgt,float)
    fwd=tgt-eye; fwd/=np.linalg.norm(fwd); right=np.cross(fwd,[0,1,0]); right/=np.linalg.norm(right); up=np.cross(right,fwd)
    C=(V-eye)@np.array([right,up,fwd]).T
    f=W/2/math.tan(math.radians(35))
    img=np.full((H,W,3),40,np.uint8); zb=np.full((H,W),np.inf)
    for m,tri in faces:
        vi=[t[0]-1 for t in tri]; c=C[vi]
        if (c[:,2]<50).any(): continue
        sx=W/2+f*c[:,0]/c[:,2]; sy=H/2-f*c[:,1]/c[:,2]
        x0,x1=int(max(0,np.floor(sx.min()))),int(min(W-1,np.ceil(sx.max())))
        y0,y1=int(max(0,np.floor(sy.min()))),int(min(H-1,np.ceil(sy.max())))
        if x0>x1 or y0>y1: continue
        den=(sy[1]-sy[2])*(sx[0]-sx[2])+(sx[2]-sx[1])*(sy[0]-sy[2])
        if abs(den)<1e-9: continue
        X,Y=np.meshgrid(np.arange(x0,x1+1)+.5,np.arange(y0,y1+1)+.5)
        a=((sy[1]-sy[2])*(X-sx[2])+(sx[2]-sx[1])*(Y-sy[2]))/den
        b=((sy[2]-sy[0])*(X-sx[2])+(sx[0]-sx[2])*(Y-sy[2]))/den; g=1-a-b
        ins=(a>=0)&(b>=0)&(g>=0)
        if not ins.any(): continue
        iz=a/c[0,2]+b/c[1,2]+g/c[2,2]; z=1/np.where(iz==0,1e-9,iz)
        sub=zb[y0:y1+1,x0:x1+1]; ok=ins&(z<sub)
        if not ok.any(): continue
        if m in tex and tri[0][1]:
            uv=T[[t[1]-1 for t in tri]]
            u=(a*uv[0,0]/c[0,2]+b*uv[1,0]/c[1,2]+g*uv[2,0]/c[2,2])*z
            v=(a*uv[0,1]/c[0,2]+b*uv[1,1]/c[1,2]+g*uv[2,1]/c[2,2])*z
            tx=tex[m]; col=tx[np.clip(((1-v)*256).astype(int),0,255),np.clip((u*256).astype(int),0,255)]
        else:
            n=np.cross(c[1]-c[0],c[2]-c[0]); n/=np.linalg.norm(n)+1e-9
            col=np.broadcast_to(np.uint8(80+150*abs(n[2])),(*ok.shape,3))
        sub[ok]=z[ok]; img[y0:y1+1,x0:x1+1][ok]=col[ok]
    raw=b''.join(b'\0'+img[y].tobytes() for y in range(H))
    ch=lambda t,x: struct.pack('>I',len(x))+t+x+struct.pack('>I',zlib.crc32(t+x)&0xffffffff)
    open(out,'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',W,H,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b''))
    print('V',len(V),'faces',len(faces),'bbox',V.min(0).round(),V.max(0).round())

if __name__=='__main__':
    a=sys.argv; main(a[1],a[2],[float(x) for x in a[3].split(',')],[float(x) for x in a[4].split(',')],*(int(x) for x in a[5:7]))
