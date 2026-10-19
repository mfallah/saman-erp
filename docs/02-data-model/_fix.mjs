import { readFileSync, writeFileSync } from 'node:fs';
const f = 'F:/harness/saman-erp/docs/02-data-model/_patch1.mjs';
let s = readFileSync(f, 'utf8');
s = s.split("'pending'").join("\\'pending\\'");
writeFileSync(f, s);
console.log('fixed');
