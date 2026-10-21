(async () => {
  let last='';
  for (let i=0;i<25;i++) {
    const logs=String((await (await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/',{headers:{Authorization:`Token ${process.env.CHABAKAN_TOKEN}`}})).json()).logs??'');
    if (logs!==last){last=logs;const l=logs.split('\n');console.log(`[${i}] len=${logs.length}\n`+l.filter(x=>/web_ui_registered|api_started|vite v|transforming|error during build|Rollup failed|ERR_PNPM|Nest application/i.test(x)).slice(-8).join('\n'));}
    if (/web_ui_registered|error during build|Rollup failed|failed to solve/i.test(logs)){console.log('RELEVANT');break;}
    await new Promise(r=>setTimeout(r,25000));
  }
  process.exit(0);
})();
