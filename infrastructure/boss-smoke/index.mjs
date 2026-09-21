// ponytail: throwaway smoke check for S1-D2/S1-VAL — proves pg-boss boots through
// pgbouncer from clean state and round-trips one job. Replace by D6's real suite.
// pg-boss v12: named export, no default
import { PgBoss as Boss } from "pg-boss";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }

async function connect() {
  const boss = new Boss({ connectionString: url, max: 5 });
  await boss.start();
  return boss;
}

let boss;
for (let i = 0; i < 30; i++) {
  try { boss = await connect(); break; }
  catch (e) {
    console.log(`waiting for pgbouncer (${i + 1}/30): ${e.message}`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
if (!boss) { console.error("could not start pg-boss"); process.exit(1); }

const queue = "smoke";
const payload = { ok: true, at: new Date().toISOString() };
// pg-boss v10: queues are explicit — send() silently returns null without this
await boss.createQueue(queue);
await boss.send(queue, payload);

const [job] = await boss.fetch(queue);
if (!job) { console.error("no job fetched"); process.exit(1); }
if (job.data.ok !== true) { console.error("payload mismatch", job.data); process.exit(1); }
await boss.complete(queue, job.id);

const stopped = await boss.stop();
console.log("boss-smoke PASS:", JSON.stringify({ jobId: job.id, payload, stopped }));
process.exit(0);
