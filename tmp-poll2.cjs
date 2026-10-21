const fs = require('node:fs');
(async () => {
  let last = '';
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/', { headers: { Authorization: `Token ${process.env.CHABAKAN_TOKEN}` } });
      const j = await r.json();
      const logs = String(j.logs ?? '');
      fs.writeFileSync('F:/harness/chabok-logs.txt', logs);
      if (logs !== last) {
        last = logs;
        console.log(`[poll ${i}] len=${logs.length}`);
        console.log(logs.split('\n').slice(-8).join('\n'));
      }
      if (/failed to solve|ERROR: process/i.test(logs)) { console.log('BUILD FAILED'); break; }
      if (/entrypoint|Saman ERP API|Nest application successfully started|listening|migrate\] applied|seed\] done/i.test(logs)) {
        console.log('APP STARTING/STARTED');
        break;
      }
    } catch (e) { console.log('poll err', e.message); }
    await new Promise(r => setTimeout(r, 20000));
  }
  process.exit(0);
})();
