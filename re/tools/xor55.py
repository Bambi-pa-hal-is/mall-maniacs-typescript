"""Decode/encode Mall Maniacs XOR-0x55 obfuscated files (maniac.cfg, config.mm, quest.txt).
Usage: python xor55.py <in> <out>"""
import sys
data = open(sys.argv[1], 'rb').read()
open(sys.argv[2], 'wb').write(bytes(b ^ 0x55 for b in data))
