import re, pathlib, sys
files = [
 'apps/api/src/modules/automation/repositories/automation.repository.ts',
 'apps/api/src/modules/automation/services/automation.service.ts',
]
pat = re.compile(r"^(\s*(?:import|export)\b.*?\bfrom\s+)(\.[^\n;]+)(\.)(;?)\s*$")
for f in files:
    p = pathlib.Path(f)
    lines = p.read_text(encoding='utf-8').split('\n')
    changed = 0
    for i, ln in enumerate(lines):
        m = pat.match(ln)
        if m:
            prefix, inner, _, semi = m.groups()
            spec = inner[1:] if inner.startswith('.') else inner
            spec = spec[:-1] if spec.endswith('.') else spec
            lines[i] = f"{prefix}'{spec}'{semi}"
            changed += 1
    p.write_text('\n'.join(lines), encoding='utf-8')
    print(f, 'fixed imports:', changed)
