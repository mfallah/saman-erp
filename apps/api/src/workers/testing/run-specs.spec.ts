/** Spawn-free worker spec runner. */
void (async () => {
  await import('../queue/outbox.dispatcher.spec');
})();
