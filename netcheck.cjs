(async () => {
  try {
    const r = await fetch('https://registry.npmjs.org/fastify', { method: 'HEAD' });
    console.log('node fetch registry:', r.status);
  } catch (e) { console.log('node fetch FAILED:', e.message); }
  try {
    const r2 = await fetch('https://pypi.org/pypi/pypdf/json');
    console.log('pypi:', r2.status);
  } catch (e) { console.log('pypi FAILED:', e.message); }
})();
