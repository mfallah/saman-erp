(async () => {
  let last='';
  for (let i=0;i<60;i++) {
    const logs=String((await (await fetch('https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/logs/',{headers:{Authorization:`Token ${process.env.CHABAKAN_TOKEN}`}})).json()).logs??'');
    if (logs!==last){last=logs;console.log(`[${i}] len=${logs.length}\n`+logs.split('\n').slice(-10).join('\n'));}
    if (/web_ui_registered|Nest application successfully started|error TS|failed to solve/i.test(logs)){console.log('RELEVANT');break;}
    await new Promise(r=>setTimeout(r,20000));
  }
  process.exit(0);
})();
