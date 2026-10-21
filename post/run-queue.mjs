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
const now = Date.now(), GRACE = 90 * 60 * 1000;   // 22 Oct: GitHub cron often runs 30+ min late; 30 min skipped 2 reels in a week
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

for (const f of readdirSync(plans).filter((n) => n.endsWith(".json"))) {
  const file = join(plans, f), plan = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  let changed = false;
  for (const it of plan.items) {
    // The queue posts Instagram and LinkedIn items, and Facebook *stories* (Facebook feed posts are scheduled natively
    // by schedule-fb.mjs and never pass through here).
    const queued = it.platform === "ig" || it.platform === "li" || (it.platform === "fb" && it.kind === "story");
    if (!queued) continue;
    const t = new Date(it.at).getTime(), status = it.status ?? "pending";
    if (list) { console.log(`${status.padEnd(9)} ${it.at}  ${it.id}  ${it.kind}  ${it.result ?? ""}`); continue; }
    if (it.platform === "li" && !process.env.LINKEDIN_TOKEN) continue; // LinkedIn not switched on yet: leave pending
    if (it.platform === "fb" && !process.env.META_PAGE_TOKEN) continue; // Facebook stories need the Page token in the secrets
    if (status !== "pending" || t > now) continue;
    const grace = it.kind === "story" ? 2 * GRACE : GRACE; // a story an hour late is still fine; a feed post is not
    if (now - t > grace) { it.status = "skipped"; it.result = `queue did not run in time for ${it.at}`; changed = true; appendFileSync(log, `${stamp()} skipped ${it.id}\n`); continue; }
    const media = (it.media ?? "").split(",").filter(Boolean).map((m) => plan.base + m.trim()).join(",");
    const args = it.platform === "li"
      ? [join(here, "li-post.mjs"), it.kind, ...(it.kind === "text" ? [it.caption] : [media, it.caption ?? ""]), ...(it.comment ? ["--comment", it.comment] : []), ...(it.title ? ["--title", it.title] : [])]
      : it.platform === "fb" ? [join(here, "fb-post.mjs"), "story", media, ""]
      : [join(here, "ig-post.mjs"), it.kind, media, it.caption ?? ""];
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
    const out = (r.stdout + r.stderr).trim(), lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const errLines = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    console.log(`${it.id}:\n${out}`);
    it.status = r.status === 0 ? "posted" : "failed";
    // When the child crashes with an uncaught exception, Node prints the stack trace and ends with its version banner
    // ("Node.js v22.23.3"). Taking the last line then records the banner as the failure reason (seen 12 Oct on ig-mon-0900),
    // so on failure prefer the "TypeError: ..." message line (Node echoes the offending source line before it, which can
    // also contain "Error"), then any line mentioning an error, then stderr, then the last line that is not the banner.
    const banner = (l) => /^Node\.js v\d/.test(l);
    it.result = r.status === 0
      ? lines.find((l) => /^\w*Error:|^published|^dry run/.test(l)) ?? lines.at(-1) ?? ""
      : lines.find((l) => /^\w*Error:/.test(l)) ?? lines.find((l) => /Error|error:/.test(l)) ?? errLines[0] ?? [...lines].reverse().find((l) => !banner(l)) ?? lines.at(-1) ?? `exit ${r.status ?? r.signal}`;
    changed = true;
    appendFileSync(log, `${stamp()} ${it.status} ${it.id}: ${it.result}\n`);
  }
  if (changed) writeFileSync(file, JSON.stringify(plan, null, 2));
  // Failures are recorded in the plan and queue.log only; the run stays green so GitHub sends no emails. Claude reads the log.
}
