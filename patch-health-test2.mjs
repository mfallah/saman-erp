import { readFileSync, writeFileSync } from 'node:fs';
const p = 'apps/api/test/health.spec.ts';
let s = readFileSync(p, 'utf8');
s = s.replace(/describe\(HTTP_TESTS_SKIP, ('[^']*'),/g, "describe($1, { skip: HTTP_TESTS_SKIP },");
writeFileSync(p, s);
console.log('fixed describe signature');
