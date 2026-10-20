import re, pathlib, json
root = pathlib.Path(r'F:\harness\saman-erp\apps\api\src')
issues = []
for p in root.rglob('*.ts'):
    s = p.read_text(encoding='utf-8')
    if not re.search(r'@(Injectable|Controller|Component)\(', s):
        continue
    # collect type-only imports
    type_only = set()
    for m in re.finditer(r'import\s+type\s*\{([^}]*)\}', s):
        for part in m.group(1).split(','):
            name = part.strip().split(' as ')[-1].strip()
            if name: type_only.add(name)
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from', s):
        for part in m.group(1).split(','):
            part = part.strip()
            if part.startswith('type '):
                type_only.add(part[5:].strip())
    # constructor block
    for cm in re.finditer(r'constructor\s*\(', s):
        i = cm.end(); depth = 1
        while i < len(s) and depth:
            if s[i] == '(': depth += 1
            elif s[i] == ')': depth -= 1
            i += 1
        block = s[cm.end():i-1]
        # split params on top-level commas
        params, cur, d2 = [], '', 0
        for ch in block:
            if ch in '(<[{': d2 += 1
            elif ch in ')>]}': d2 -= 1
            if ch == ',' and d2 == 0:
                params.append(cur); cur = ''
            else:
                cur += ch
        if cur.strip(): params.append(cur)
        for prm in params:
            prm = ' '.join(prm.split())
            if '@Inject(' in prm: continue
            tm = re.search(r':\s*([A-Za-z_$][\w$]*)', prm)
            if not tm: continue
            tname = tm.group(1)
            if tname in type_only:
                issues.append((str(p.relative_to(root)), tname, prm[:90]))
print('type-only injected constructor params:', len(issues))
for f, t, prm in issues:
    print(f'{f} :: {t} :: {prm}')
