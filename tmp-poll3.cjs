const fs = require('node:fs');
(async () => {
  let last = '';
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/', { headers: { Authorization: `Token ${process.env.CHABAKAN_TOKEN}` } });
      const j = await r.json();
      const logs = String(j.logs ?? '');
      fs.writeFileSync('F:/harness/chabok-logs.txt', logs);
      const tail = logs.split('\n').slice(-6).join('\n');
      if (logs !== last) { last = logs; console.log(`[poll ${i}] len=${logs.length}\n${tail}`); }
      if (/failed to solve|ERR_PNPM|ERROR: process/i.test(logs)) { console.log('BUILD FAILED'); break; }
      if (/\[entrypoint\]|Nest application successfully started|health|migrate\] applied|seed\] done/i.test(logs)) { console.log('APP PHASE REACHED'); break; }
    } catch (e) { console.log('poll err', e.message); }
    await new Promise(r => setTimeout(r, 25000));
  }
  process.exit(0);
})();
