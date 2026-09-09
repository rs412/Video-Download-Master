#!/usr/bin/env python3
# 用标准库生成下载图标（向下箭头 + 托盘），无需第三方依赖。
# v2：背景加轻微垂直渐变（更亮的红 → 稍深红），四角小圆角（抗锯齿）。
import zlib, struct, os

TOP = (255, 56, 92, 255)    # 顶部：更亮更跳的红
BOT = (228, 0, 45, 255)     # 底部：稍深的红
FG = (255, 255, 255, 255)

def write_png(path, size, buf):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw.extend(buf[y * size * 4:(y + 1) * size * 4])
    comp = zlib.compress(bytes(raw), 9)
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))

def sign(p1, p2, p3):
    return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1])

def in_tri(p, a, b, c):
    d1, d2, d3 = sign(p, a, b), sign(p, b, c), sign(p, c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)

def corner_alpha(p, size, r):
    """圆角矩形覆盖度（0~1，带 1px 抗锯齿）"""
    half = size / 2.0
    cx, cy = half, half
    dx = max(abs(p[0] - cx) - (half - r), 0.0)
    dy = max(abs(p[1] - cy) - (half - r), 0.0)
    d = (dx * dx + dy * dy) ** 0.5 - r
    if d <= -0.5: return 1.0
    if d >= 0.5: return 0.0
    return 0.5 - d

def draw_icon(size):
    buf = bytearray(size * size * 4)
    r = size * 0.11  # 圆角半径：一点点圆
    for y in range(size):
        t = y / max(1, size - 1)
        bg = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(4))
        for x in range(size):
            p = (x + 0.5, y + 0.5)
            a = corner_alpha(p, size, r)
            if a <= 0: continue
            idx = (y * size + x) * 4
            # 渐变背景
            for i in range(3):
                buf[idx + i] = bg[i]
            buf[idx + 3] = bg[3]
            # 白色前景（箭头/托盘），受圆角裁剪
            cx = size / 2.0
            tip = (cx, size * 0.67)
            left = (cx - size * 0.20, size * 0.39)
            right = (cx + size * 0.20, size * 0.39)
            hit = in_tri(p, left, right, tip)
            if not hit and int(size*0.22) <= y < int(size*0.40) and \
               int(cx - size*0.055) <= x < int(cx + size*0.055):
                hit = True  # 杆
            if not hit and int(size*0.74) <= y < int(size*0.80) and \
               int(cx - size*0.24) <= x < int(cx + size*0.24):
                hit = True  # 托盘
            if hit and a < 1.0:
                # 前景与背景按覆盖度混合（边缘平滑）
                for i in range(3):
                    buf[idx + i] = int(buf[idx + i] * (1 - a) + FG[i] * a)
            elif hit:
                for i in range(3):
                    buf[idx + i] = FG[i]
    return buf

out = os.path.join(os.path.dirname(__file__), "icons")
for s in (16, 48, 128):
    write_png(os.path.join(out, "icon%d.png" % s), s, draw_icon(s))
    print("wrote icon%d.png" % s)
