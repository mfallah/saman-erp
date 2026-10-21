const fs = require('node:fs');
(async () => {
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/', { headers: { Authorization: `Token ${process.env.CHABAKAN_TOKEN}` } });
      const j = await r.json();
      const logs = String(j.logs ?? '');
      fs.writeFileSync('F:/harness/chabok-logs.txt', logs);
      const tail = logs.split('\n').slice(-6).join('\n');
      console.log(`[poll ${i}] len=${logs.length}`);
      console.log(tail);
      if (/Successfully built|DONE.*exporting|ERROR|error:|npm ERR|failed to solve/i.test(tail)) {
        if (/ERROR|error:|npm ERR|failed to solve/i.test(tail)) { console.log('BUILD FAILED'); break; }
      }
    } catch (e) { console.log('poll err', e.message); }
    await new Promise(r => setTimeout(r, 20000));
  }
  process.exit(0);
})();
