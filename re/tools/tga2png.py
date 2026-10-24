"""Convert an uncompressed or RLE TGA (8/16/24/32-bit) to PNG. Usage: python -I tga2png.py in.tga out.png"""
import struct, sys, zlib

def read_tga(path):
    d = open(path, 'rb').read()
    idlen, cmtype, itype = d[0], d[1], d[2]
    cmfirst, cmlen, cmbits = struct.unpack_from('<HHB', d, 3)
    w, h, bpp, desc = struct.unpack_from('<HHBB', d, 12)
    o = 18 + idlen
    pal = None
    if cmtype:
        pal = d[o:o + cmlen * (cmbits // 8)]
        o += cmlen * (cmbits // 8)
    px = w * h
    bypp = bpp // 8
    raw = bytearray()
    if itype in (1, 2, 3):
        raw = d[o:o + px * bypp]
    elif itype in (9, 10, 11):
        while len(raw) < px * bypp:
            hdr = d[o]; o += 1
            n = (hdr & 0x7f) + 1
            if hdr & 0x80:
                raw += d[o:o + bypp] * n; o += bypp
            else:
                raw += d[o:o + n * bypp]; o += n * bypp
    else:
        raise ValueError(f'unsupported TGA type {itype}')
    rgba = bytearray(px * 4)
    for i in range(px):
        if bypp == 1 and pal is not None:
            e = raw[i] * (cmbits // 8)
            b, g, r = pal[e], pal[e + 1], pal[e + 2]
            a = pal[e + 3] if cmbits == 32 else 255
        elif bypp == 2:
            v = raw[i * 2] | raw[i * 2 + 1] << 8
            r, g, b, a = (v >> 10 & 31) * 255 // 31, (v >> 5 & 31) * 255 // 31, (v & 31) * 255 // 31, 255
        elif bypp == 1:
            r = g = b = raw[i]; a = 255
        else:
            b, g, r = raw[i * bypp], raw[i * bypp + 1], raw[i * bypp + 2]
            a = raw[i * bypp + 3] if bypp == 4 else 255
        rgba[i * 4:i * 4 + 4] = bytes((r, g, b, a))
    if not desc & 0x20:  # bottom-up
        rows = [rgba[y * w * 4:(y + 1) * w * 4] for y in range(h)][::-1]
        rgba = b''.join(rows)
    return w, h, bytes(rgba), (itype, bpp, cmtype)

def write_png(path, w, h, rgba):
    raw = b''.join(b'\0' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    ch = lambda t, x: struct.pack('>I', len(x)) + t + x + struct.pack('>I', zlib.crc32(t + x) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))

if __name__ == '__main__':
    w, h, rgba, info = read_tga(sys.argv[1])
    write_png(sys.argv[2], w, h, rgba)
    print(sys.argv[1].split('\\')[-1], w, h, info)
