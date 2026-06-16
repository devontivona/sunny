/**
 * On server init: start the WDK Postgres world (subscribe to the graphile-worker
 * queue so durable steps/jobs run), then start Sunny's runtime (DB, memory,
 * gateway). Both are memoized/idempotent. A Nitro plugin is just a default-
 * exported function (`defineNitroPlugin` is an identity helper), so we skip it.
 */
export default async (): Promise<void> => {
  const { getWorld } = await import('workflow/runtime');
  await getWorld().start?.();

  const { getRuntime } = await import('../src/runtime.js');
  await getRuntime();
};
