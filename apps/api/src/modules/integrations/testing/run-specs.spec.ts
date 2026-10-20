/** Spawn-free integrations spec runner (tsc-compiled; see channels run-specs). */
void (async () => {
  await import('../limo/limo.client.spec');
  await import('../sms/sms-budget.spec');
  await import('../otp/otp.service.spec');
})();
