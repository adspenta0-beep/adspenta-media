// Generate the daily Instagram + Facebook story plan: 5 slots a day, each slot one or two stories, so 6 to 7 stories
// a day per platform and something is always live (stories last 24 h). Deterministic: the same inputs give the same
// plan, and existing items in the output file keep their status.
//
//   node make-stories.mjs 2026-10-15 2026-11-15 plans/2026-stories.json
//
// Slots (Bucharest): 09:30 two slides of a 9:16 deck (cover + answer), 12:30 a video, 15:30 a card, 18:30 the day's
// feed post again (from the other plans), 21:30 a video. Facebook gets the same story 3 minutes after Instagram.
// Pools rotate so nothing repeats within about a week. Decks use the "-tt" 1080x1920 JPG slides (TikTok and stories).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Story images are fitted into a 1080x1920 canvas inside the safe zone (Instagram covers roughly the top 250 px with
// the name bar and the bottom 300 px with the reply box, and zooms any non-9:16 image to fill the screen, cutting the
// sides). The canvas colour is sampled from the image's corner so the padding is invisible. Output: <name>-story.jpg.
const storyFit = (repo, file) => {
  const out = file.replace(/\.(png|jpe?g)$/i, "") + "-story.jpg";
  if (!existsSync(join(repo, out))) {
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", join(repo, file), "-vf", "crop=2:2:0:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const color = "0x" + [...px.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(repo, file), "-vf", `scale=960:1500:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2-40:color=${color}`, "-q:v", "2", "-pix_fmt", "yuvj420p", join(repo, out)]);
  }
  return out;
};

const here = dirname(fileURLToPath(import.meta.url));
const [from, to, outRel] = process.argv.slice(2);
if (!from || !to || !outRel) { console.error("usage: node make-stories.mjs <from YYYY-MM-DD> <to> <out.json>"); process.exit(1); }
const out = join(here, outRel), plansDir = join(here, "plans");
const repo = join(here, "..", "..", "_repo");
const have = new Set(readdirSync(repo));

const decks = ["d01-spot-it-account", "d02-spot-it-tired-ad", "d03-spot-it-runaway-budget", "d04-monday-checklist", "d07-myth-ai-spends-money", "d09-plain-words-pacing", "d10-plain-words-frequency", "d11-plain-words-tracking", "d13-what-adspenta-is", "d15-six-words"]
  .filter((d) => have.has(`${d}-tt-01.jpg`));
const slidesOf = (d) => { const s = []; for (let i = 1; i <= 9; i++) { const f = `${d}-tt-0${i}.jpg`; if (have.has(f)) s.push(f); } return s; };
const videos = [...have].filter((f) => /^(V\d\d|B\d\d)-.*9x16\.mp4$/.test(f) && !/clean/.test(f)).sort();
const cards = [...have].filter((f) => /^(post-cards-0\d(-v2)?|quote-card-01|before-after|d1[78]-[a-z-]+)\.png$/.test(f)).sort();
if (!decks.length || videos.length < 7) { console.error("pools too small; push the -tt jpgs and the videos first"); process.exit(1); }

// the day's feed post from the other plans (first media of the 18:00 Instagram item), for the 18:30 repost
const feedByDay = {};
for (const f of readdirSync(plansDir).filter((n) => n.endsWith(".json") && !n.includes("stories"))) {
  const p = JSON.parse(readFileSync(join(plansDir, f), "utf8").replace(/^﻿/, ""));
  for (const it of p.items) if (it.platform === "ig" && it.kind !== "story" && it.at.endsWith("T18:00")) feedByDay[it.at.slice(0, 10)] = it.media.split(",")[0].trim();
}

const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) : { items: [] };
const keep = new Map(prev.items.map((i) => [i.id, i]));
const items = [];
const push = (day, time, tag, media) => {
  if (!/\.mp4$/i.test(media)) media = storyFit(repo, media); // images: safe-zone canvas; videos are 9:16 already
  for (const [platform, offset] of [["ig", 0], ["fb", 3]]) {
    const [h, m] = time.split(":").map(Number), mm = m + offset;
    const at = `${day}T${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const id = `st-${platform}-${day}-${tag}`, old = keep.get(id);
    // keep posted/skipped/failed history; pending items take the current media (so a fix like this one reaches them)
    items.push(old && old.status ? old : { ...(old ?? {}), id, platform, kind: "story", at, media });
  }
};

const d0 = new Date(from + "T00:00:00Z"), d1 = new Date(to + "T00:00:00Z");
let n = 0;
for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1), n++) {
  const day = d.toISOString().slice(0, 10);
  const deck = decks[n % decks.length], slides = slidesOf(deck), pair = Math.floor(n / decks.length);
  const a = slides[(2 * pair) % slides.length], b = slides[(2 * pair + 1) % slides.length];
  push(day, "09:30", "deck-a", a); if (b && b !== a) push(day, "09:32", "deck-b", b);
  push(day, "12:30", "video-1", videos[(2 * n) % videos.length]);
  push(day, "15:30", "card", cards[n % cards.length]);
  if (feedByDay[day]) push(day, "18:30", "feed", feedByDay[day]);
  push(day, "21:30", "video-2", videos[(2 * n + 1) % videos.length]);
}
items.sort((x, y) => x.at.localeCompare(y.at) || x.platform.localeCompare(y.platform));
writeFileSync(out, JSON.stringify({ week: `Stories ${from} to ${to}, generated by make-stories.mjs`, base: "https://raw.githubusercontent.com/adspenta0-beep/adspenta-media/main/", items }, null, 2));
console.log(`${items.length} story items (${items.length / 2} per platform) for ${n} days; decks ${decks.length}, videos ${videos.length}, cards ${cards.length}, feed reposts ${Object.keys(feedByDay).length}`);
