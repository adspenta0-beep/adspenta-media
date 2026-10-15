// Publish to the Adspenta Facebook Page through Meta's own Graph API, no third party.
// Page id and Page token come from Windows user env vars META_PAGE_ID and META_PAGE_TOKEN; nothing is printed or stored.
//
//   node fb-post.mjs text   "<message>"                              [--at "2026-10-12T20:00"]
//   node fb-post.mjs photo  "<public image url>"      "<message>"    [--at ...]
//   node fb-post.mjs photos "<url1>,<url2>,..."       "<message>"    [--at ...]   (multi-photo post, up to 10)
//   node fb-post.mjs video  "<public mp4 url>"        "<message>"    [--at ...] [--title "..."]
//   node fb-post.mjs reel   "<public mp4 url>"        "<message>"    [--at ...]
//   add --dry to validate inputs and stop before anything is created.
//
// --at schedules natively on Facebook (local time on this PC, 10 min to 30 days ahead); the post shows as "scheduled"
// in Meta Business Suite and goes out without the PC being on. Without --at it publishes at once.
const argv = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dry") opt.dry = true;
  else if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [kind, media, message = ""] = pos;
const dry = !!opt.dry, at = opt.at ?? null, title = opt.title ?? null;
const TOKEN = process.env.META_PAGE_TOKEN, PAGE = process.env.META_PAGE_ID, V = "v26.0", API = `https://graph.facebook.com/${V}`;
if (!TOKEN || !PAGE) { console.error("META_PAGE_TOKEN / META_PAGE_ID not set in the user environment"); process.exit(1); }
if (!kind || !media) { console.error("usage: node fb-post.mjs text|photo|photos|video|reel <text|url[,url]> [message] [--at time] [--dry]"); process.exit(1); }

const sched = {};
if (at) {
  const ts = Math.floor(new Date(at).getTime() / 1000);
  const minutes = (ts - Date.now() / 1000) / 60;
  if (!(minutes >= 10 && minutes <= 30 * 24 * 60)) { console.error(`--at must be 10 minutes to 30 days ahead (got ${minutes.toFixed(0)} min)`); process.exit(1); }
  Object.assign(sched, { published: "false", scheduled_publish_time: String(ts) });
}
const call = async (path, params, method = "POST") => {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = method === "GET" ? await fetch(`${API}/${path}?${body}`) : await fetch(`${API}/${path}`, { method, body });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error.message} (code ${j.error.code})`);
  return j;
};

if (dry) { console.log(`dry run: ${kind} ${at ? "scheduled for " + at : "publish now"}; nothing created`); process.exit(0); }

let id;
if (kind === "text") {
  id = (await call(`${PAGE}/feed`, { message: media, ...sched })).id;
} else if (kind === "photo") {
  id = (await call(`${PAGE}/photos`, { url: media, message, ...sched })).id;
} else if (kind === "photos") {
  const urls = media.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2 || urls.length > 10) throw new Error("photos needs 2 to 10 urls");
  const ids = [];
  for (const u of urls) ids.push((await call(`${PAGE}/photos`, { url: u, published: "false" })).id);
  const params = { message, ...sched };
  ids.forEach((pid, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: pid })));
  id = (await call(`${PAGE}/feed`, params)).id;
} else if (kind === "video") {
  const p = { file_url: media, description: message, ...sched };
  if (title) p.title = title;
  id = (await call(`${PAGE}/videos`, p)).id;
} else if (kind === "reel") {
  // The Reels upload endpoint (rupload.facebook.com/video-reels) answered "doesn't exist" on v26.0 (11 Oct 2026),
  // so a reel is posted as a Page video with file_url, which schedules natively and still lands in the Reels tab for 9:16.
  const p = { file_url: media, description: message, ...sched };
  if (title) p.title = title;
  id = (await call(`${PAGE}/videos`, p)).id;
} else if (kind === "story") {
  // Page Stories API: a photo is uploaded unpublished then turned into a story; a video goes through video_stories
  // (start -> Meta pulls the hosted file -> finish). Stories cannot be scheduled: the queue posts them when due.
  if (at) throw new Error("stories cannot be scheduled; the queue posts them when due");
  if (/\.mp4(\?|$)/i.test(media)) {
    const s = await call(`${PAGE}/video_stories`, { upload_phase: "start" });
    const up = await fetch(`https://rupload.facebook.com/video-upload/${V}/${s.video_id}`, { method: "POST", headers: { Authorization: `OAuth ${TOKEN}`, file_url: media } });
    const uj = await up.json(); if (!uj.success) throw new Error(`story video upload: ${JSON.stringify(uj).slice(0, 200)}`);
    for (let i = 0; i < 36; i++) { // wait until Meta has pulled and processed the file
      const st = await call(s.video_id, { fields: "status" }, "GET");
      const ph = st.status?.uploading_phase?.status, pr = st.status?.processing_phase?.status;
      if (ph === "complete" && (pr === "complete" || pr === "not_started" || !pr)) break;
      if (ph === "error" || pr === "error") throw new Error(`story video failed: ${JSON.stringify(st.status).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    const fin = await call(`${PAGE}/video_stories`, { upload_phase: "finish", video_id: s.video_id });
    id = fin.post_id ?? s.video_id;
  } else {
    const ph = await call(`${PAGE}/photos`, { url: media, published: "false" });
    const st = await call(`${PAGE}/photo_stories`, { photo_id: ph.id });
    id = st.post_id ?? ph.id;
  }
} else if (kind === "reel-upload") {
  // Reels: start upload session -> Meta pulls the file -> publish (or schedule).
  const s = await call(`${PAGE}/video_reels`, { upload_phase: "start" });
  const up = await fetch(`https://rupload.facebook.com/video-upload/${V}/${s.video_id}`, { method: "POST", headers: { Authorization: `OAuth ${TOKEN}`, file_url: media } });
  const uj = await up.json(); if (!uj.success) throw new Error(`reel upload: ${JSON.stringify(uj)}`);
  for (let i = 0; i < 60; i++) {
    const st = await call(s.video_id, { fields: "status" }, "GET");
    if (st.status?.uploading_phase?.status === "complete") break;
    if (st.status?.uploading_phase?.status === "error") throw new Error(`reel processing failed: ${JSON.stringify(st.status)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const fin = { upload_phase: "finish", video_id: s.video_id, description: message, video_state: at ? "SCHEDULED" : "PUBLISHED" };
  if (at) fin.scheduled_publish_time = sched.scheduled_publish_time;
  await call(`${PAGE}/video_reels`, fin);
  id = s.video_id;
} else { console.error(`unknown kind ${kind}`); process.exit(1); }

console.log(`${at ? "scheduled" : "published"} ${kind}: id ${id}${at ? " for " + at : ""}`);
