#!/usr/bin/env python3
"""Gera os ícones da extensão (PNG RGBA) sem dependências externas.

Desenha uma "moeda" laranja com anel branco, renderizada com supersampling 4x
para bordas suaves. Uso: python3 tools/make-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = [16, 32, 48, 128]
SS = 4  # supersampling

ORANGE = (255, 106, 0, 255)
ORANGE_DARK = (224, 90, 0, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def blend(dst, src):
    a = src[3] / 255.0
    if a <= 0:
        return dst
    return (
        int(src[0] * a + dst[0] * (1 - a)),
        int(src[1] * a + dst[1] * (1 - a)),
        int(src[2] * a + dst[2] * (1 - a)),
        int(255 * (a + dst[3] / 255.0 * (1 - a))),
    )


def render(size):
    big = size * SS
    cx = cy = big / 2.0
    r_out = big * 0.47
    r_ring = big * 0.34
    r_ring_w = max(1.0, big * 0.045)
    r_core = big * 0.20

    px = [[TRANSPARENT] * big for _ in range(big)]
    for y in range(big):
        dy = y + 0.5 - cy
        for x in range(big):
            dx = x + 0.5 - cx
            d = (dx * dx + dy * dy) ** 0.5
            if d <= r_out:
                # Borda escura quando perto do limite externo.
                color = ORANGE_DARK if d > r_out - big * 0.06 else ORANGE
                if abs(d - r_ring) <= r_ring_w:
                    color = WHITE
                elif d <= r_core:
                    color = WHITE
                px[y][x] = color

    # Downsample por média (4x4).
    out = [[TRANSPARENT] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = px[y * SS + sy][x * SS + sx]
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
                    acc[3] += c[3]
            n = SS * SS
            out[y][x] = (acc[0] // n, acc[1] // n, acc[2] // n, acc[3] // n)
    return out


def write_png(path, pixels):
    size = len(pixels)
    raw = b""
    for y in range(size):
        raw += b"\x00" + b"".join(struct.pack("4B", *pixels[y][x]) for x in range(size))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        write_png(os.path.join(OUT_DIR, f"icon{size}.png"), render(size))
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
