// Runs the due Instagram items of every plan in ./plans (Instagram's API has no native scheduling).
// Meant for a Windows Task Scheduler job every 5 minutes, as the logged-in user (so the user env vars are there).
// An item is posted when its time has come and is at most 30 minutes old; older ones are marked "skipped" and
// never posted late. Results are written back into the plan file (status, permalink or error) and to queue.log.
//
//   node run-queue.mjs           run due items
//   node run-queue.mjs --list    show every item and its status, post nothing
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plans = join(here, "plans"), log = join(here, "queue.log");
const list = process.argv.includes("--list");
const now = Date.now(), GRACE = 30 * 60 * 1000;
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

for (const f of readdirSync(plans).filter((n) => n.endsWith(".json"))) {
  const file = join(plans, f), plan = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const it of plan.items) {
    if (it.platform !== "ig") continue;
    const t = new Date(it.at).getTime(), status = it.status ?? "pending";
    if (list) { console.log(`${status.padEnd(9)} ${it.at}  ${it.id}  ${it.kind}  ${it.result ?? ""}`); continue; }
    if (status !== "pending" || t > now) continue;
    if (now - t > GRACE) { it.status = "skipped"; it.result = `PC was off or job not running at ${it.at}`; changed = true; appendFileSync(log, `${stamp()} skipped ${it.id}\n`); continue; }
    const media = it.media.split(",").map((m) => plan.base + m.trim()).join(",");
    const r = spawnSync(process.execPath, [join(here, "ig-post.mjs"), it.kind, media, it.caption ?? ""], { encoding: "utf8", env: process.env });
    const out = (r.stdout + r.stderr).trim(), lines = out.split("\n");
    console.log(`${it.id}:\n${out}`);
    it.status = r.status === 0 ? "posted" : "failed"; it.result = lines.find((l) => /^\w*Error:|^published|^dry run/.test(l)) ?? lines.pop(); changed = true;
    appendFileSync(log, `${stamp()} ${it.status} ${it.id}: ${it.result}\n`);
  }
  if (changed) writeFileSync(file, JSON.stringify(plan, null, 2));
}
