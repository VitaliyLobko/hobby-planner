"""Іконки застосунку з геометрії icons/icon.svg (кільце таймера з галочкою) — PNG для маніфесту й iOS.

SCALE — розмір кільця відносно svg; maskable дрібніша (MASK), щоб кільце лишалось у безпечному колі Android (r = 40%).
Запуск: python scripts/make_icons.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

SCALE = 1.2
MASK = 0.78
SS = 4  # малюємо вчетверо більшим і зменшуємо — згладжені краї
ICONS = Path(__file__).resolve().parent.parent / 'icons'


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def render(size, k):
    n = 512 * SS
    a, b = hex_rgb('#1f8a70'), hex_rgb('#0f4c5c')
    # Діагональний градієнт: смуга на кожне значення x + y
    grad = Image.new('RGB', (2 * n, 1))
    grad.putdata([tuple(round(a[c] + (b[c] - a[c]) * i / (2 * n - 1)) for c in range(3)) for i in range(2 * n)])
    bg = Image.new('RGB', (n, n))
    for y in range(n):
        bg.paste(grad.crop((y, 0, y + n, 1)), (0, y))

    over = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    s = SS * k
    c = 256 * SS
    p = lambda x, y: (c + (x - 256) * s, c + (y - 256) * s)  # noqa: E731
    dot = lambda x, y, w, col: d.ellipse([p(x, y)[0] - w / 2, p(x, y)[1] - w / 2, p(x, y)[0] + w / 2, p(x, y)[1] + w / 2], fill=col)  # noqa: E731

    r, w = 150 * s, 44 * s
    box = [c - r - w / 2, c - r - w / 2, c + r + w / 2, c + r + w / 2]
    d.ellipse(box, outline=(255, 255, 255, 46), width=round(w))
    over2 = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(over2)
    yellow = (255, 209, 102, 255)
    end = math.degrees(math.atan2(307 - 256, 115 - 256))
    d.arc(box, -90, end, fill=yellow, width=round(w))
    dot(256, 106, w, yellow)
    dot(115, 307, w, yellow)
    pts = [(190, 262), (236, 308), (328, 204)]
    cw = 40 * s
    d.line([p(*q) for q in pts], fill=(255, 255, 255, 255), width=round(cw))
    for q in pts:
        dot(*q, cw, (255, 255, 255, 255))

    img = Image.alpha_composite(Image.alpha_composite(bg.convert('RGBA'), over), over2).convert('RGB')
    return img.resize((size, size), Image.LANCZOS)


for name, size, k in [('icon-512', 512, SCALE), ('icon-192', 192, SCALE), ('apple-touch-icon', 180, SCALE),
                      ('icon-maskable-512', 512, SCALE * MASK)]:
    render(size, k).save(ICONS / f'{name}.png', optimize=True)
    print(name)
