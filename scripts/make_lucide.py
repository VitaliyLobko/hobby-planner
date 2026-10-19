"""Збирає js/icons-lucide.js: лише ті іконки Lucide, що названі в ICON_GROUPS і яких немає в ICONS.

Запуск: py scripts/make_lucide.py <розпакований пакет lucide-static>/package
"""
import pathlib
import re
import sys

app = pathlib.Path(__file__).resolve().parent.parent
pkg = pathlib.Path(sys.argv[1])
version = re.search(r'"version":\s*"([^"]+)"', (pkg / 'package.json').read_text('utf-8')).group(1)

model = (app / 'js' / 'model.js').read_text('utf-8')
block = model[model.index('export const ICON_GROUPS'):]
block = block[:block.index('\n];') + 3]
keys = re.findall(r"\['([a-z0-9-]+)',", block)
own = set(re.findall(r'^  ([a-zA-Z0-9]+):', (app / 'js' / 'icons.js').read_text('utf-8'), re.M))

dupes = sorted({k for k in keys if keys.count(k) > 1})
if dupes:
    sys.exit(f'дублікати: {dupes}')

out = {}
missing = []
for key in keys:
    if key in own or key in out:
        continue
    f = pkg / 'icons' / f'{key}.svg'
    if not f.exists():
        missing.append(key)
        continue
    svg = f.read_text('utf-8')
    inner = svg[svg.index('>', svg.index('<svg')) + 1:svg.rindex('</svg>')]
    inner = re.sub(r'\s*\n\s*', '', inner).replace(' />', '/>').strip()
    if "'" in inner:
        sys.exit(f'лапка в {key}')
    out[key] = inner
if missing:
    sys.exit(f'немає в Lucide: {missing}')

lines = [
    f'// Іконки Lucide v{version} (https://lucide.dev), лише ті, що є в ICON_GROUPS.',
    '// Згенеровано скриптом scripts/make_lucide.py — руками не правити, а перегенерувати.',
    '//',
    '// ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022',
    '// as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.',
    '// Permission to use, copy, modify, and/or distribute this software for any purpose with or without',
    '// fee is hereby granted, provided that the above copyright notice and this permission notice appear',
    '// in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.',
    'export const LUCIDE = {',
]
lines += [f"  '{k}': '{v}'," for k, v in out.items()]
lines.append('};')
(app / 'js' / 'icons-lucide.js').write_text('\n'.join(lines) + '\n', 'utf-8', newline='\n')
print(len(out), 'іконок,', sum(len(v) for v in out.values()), 'байт SVG')
