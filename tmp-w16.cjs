(async () => {
  let last='';
  for (let i=0;i<22;i++) {
    const logs=String((await (await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/',{headers:{Authorization:`Token ${process.env.CHABAKAN_TOKEN}`}})).json()).logs??'');
    if (logs!==last){last=logs;const l=logs.split('\n');console.log(`[${i}] len=${logs.length}\n`+l.filter(x=>/web_ui_registered|api_started|error during build|Rollup failed|ERR_PNPM|failed to solve|COPY failed|Nest application/i.test(x)).slice(-8).join('\n'));}
    if (/web_ui_registered|failed to solve|COPY failed|error during build/i.test(logs)){console.log('RELEVANT');break;}
    await new Promise(r=>setTimeout(r,25000));
  }
  process.exit(0);
})();
