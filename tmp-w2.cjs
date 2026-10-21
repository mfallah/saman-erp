(async () => {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const logs = String((await (await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/', { headers: { Authorization: `Token ${process.env.CHABAKAN_TOKEN}` } })).json()).logs ?? '');
    if (logs !== last) { last = logs; console.log(`[${i}] len=${logs.length}\n` + logs.split('\n').slice(-10).join('\n')); }
    if (/entrypoint.*migrations|migrate\] applied|seed\] done|Nest application successfully started/i.test(logs)) { console.log('APP STARTED'); break; }
    if (/failed to solve|ERROR: process/i.test(logs)) { console.log('BUILD FAILED'); break; }
    await new Promise(r => setTimeout(r, 20000));
  }
  process.exit(0);
})();
