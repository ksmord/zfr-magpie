#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 assets/icon.png —— 纯标准库，无 PIL 依赖。
512 渲染 + 2x2 超采样下采样到 256，得到抗锯齿边缘。
图形：深色圆角方底 + 青紫渐变环（带缺口与箭头，表示 egress 轮换）+ 白色 Z 字。
"""
import zlib, struct, math, os

W = 256
SS = 2                 # 超采样倍数
S = W * SS

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

BG_TOP = (18, 22, 29)
BG_BOT = (11, 14, 19)
CYAN = (34, 211, 238)
VIOLET = (168, 85, 247)
INK = (240, 245, 251)

def in_rounded_rect(x, y, w, h, r):
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > w - r and y < r:
        return (x - (w - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > h - r:
        return (x - r) ** 2 + (y - (h - r)) ** 2 <= r * r
    if x > w - r and y > h - r:
        return (x - (w - r)) ** 2 + (y - (h - r)) ** 2 <= r * r
    return 0 <= x <= w and 0 <= y <= h

def in_poly(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1
            if x < xin:
                inside = not inside
    return inside

def build():
    cx = cy = S / 2
    ring_r = S * 0.335
    ring_w = S * 0.072
    # 环缺口：-50° 到 -10°（右上），箭头接在 -10° 处
    gap_a, gap_b = math.radians(-58), math.radians(-12)

    # Z 字三个多边形：上横、斜、下横
    z_w = S * 0.30          # 宽
    z_h = S * 0.30          # 高
    th = S * 0.062          # 笔画粗细
    z_x0, z_y0 = cx - z_w / 2, cy - z_h / 2
    top = [(z_x0, z_y0), (z_x0 + z_w, z_y0), (z_x0 + z_w, z_y0 + th), (z_x0, z_y0 + th)]
    bot = [(z_x0, z_y0 + z_h - th), (z_x0 + z_w, z_y0 + z_h - th), (z_x0 + z_w, z_y0 + z_h), (z_x0, z_y0 + z_h)]
    diag = [(z_x0 + z_w - th * 1.15, z_y0 + th),
            (z_x0 + z_w, z_y0 + th),
            (z_x0 + th * 1.15, z_y0 + z_h - th),
            (z_x0, z_y0 + z_h - th)]

    # 箭头三角：位于缺口终点外侧，指向顺时针
    aa = gap_b
    ax, ay = cx + ring_r * math.cos(aa), cy + ring_r * math.sin(aa)
    tx, ty = -math.sin(aa), math.cos(aa)     # 切线方向
    nx, ny = math.cos(aa), math.sin(aa)      # 法线
    ah = S * 0.105                           # 箭头长
    aw = S * 0.085                           # 箭头宽
    arrow = [(ax + tx * ah, ay + ty * ah),
             (ax + nx * aw * 0.7, ay + ny * aw * 0.7),
             (ax - nx * aw * 0.7, ay - ny * aw * 0.7)]

    buf = bytearray(S * S * 4)
    for py in range(S):
        for px in range(S):
            x, y = px + 0.5, py + 0.5
            i = (py * S + px) * 4
            if not in_rounded_rect(x, y, S - 0.5, S - 0.5, S * 0.22):
                continue
            # 背景竖向渐变
            r, g, b = lerp(BG_TOP, BG_BOT, y / S)
            a = 255
            # 环
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)
            ang = math.atan2(dy, dx)
            in_gap = gap_a <= ang <= gap_b
            if abs(d - ring_r) <= ring_w / 2 and not in_gap:
                t = (ang + math.pi) / (2 * math.pi)
                r, g, b = lerp(CYAN, VIOLET, t)
            # 箭头
            if in_poly(x, y, arrow):
                r, g, b = VIOLET
            # Z
            if in_poly(x, y, top) or in_poly(x, y, bot) or in_poly(x, y, diag):
                r, g, b = INK
            buf[i:i + 4] = bytes((r, g, b, a))

    # 下采样 SS×SS
    out = bytearray(W * W * 4)
    n = SS * SS
    for oy in range(W):
        for ox in range(W):
            ar = ag = ab = aa_ = 0
            for sy in range(SS):
                for sx in range(SS):
                    si = ((oy * SS + sy) * S + (ox * SS + sx)) * 4
                    ar += buf[si]; ag += buf[si + 1]; ab += buf[si + 2]; aa_ += buf[si + 3]
            oi = (oy * W + ox) * 4
            out[oi:oi + 4] = bytes((ar // n, ag // n, ab // n, aa_ // n))
    return bytes(out)

def write_png(path, rgba, w, h):
    raw = b''.join(b'\x00' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)

if __name__ == '__main__':
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根目录
    outdir = os.path.join(here, 'assets')
    os.makedirs(outdir, exist_ok=True)
    data = build()
    for name, size in (('icon.png', 256), ('icon-128.png', 128)):
        # 128 版本：直接对 256 做 2x2 平均
        if size == 128:
            small = bytearray(size * size * 4)
            for oy in range(size):
                for ox in range(size):
                    acc = [0, 0, 0, 0]
                    for sy in range(2):
                        for sx in range(2):
                            si = ((oy * 2 + sy) * 256 + (ox * 2 + sx)) * 4
                            for k in range(4):
                                acc[k] += data[si + k]
                    oi = (oy * size + ox) * 4
                    small[oi:oi + 4] = bytes(v // 4 for v in acc)
            write_png(os.path.join(outdir, name), bytes(small), size, size)
        else:
            write_png(os.path.join(outdir, name), data, size, size)
        print('written', os.path.join(outdir, name))
