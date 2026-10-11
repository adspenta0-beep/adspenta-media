// Publish to Instagram through Meta's own API (Instagram API with Instagram Login), no third party.
// Token and account id come from Windows user env vars IG_TOKEN and IG_USER_ID; nothing is printed or stored.
//
//   node ig-post.mjs image   "<public image url>"            "<caption>"
//   node ig-post.mjs reel    "<public mp4 url>"              "<caption>" [--cover <public jpg url>]
//   node ig-post.mjs carousel "<url1>,<url2>,..."            "<caption>"
//   node ig-post.mjs story   "<public image or mp4 url>"
//   add --dry to build the container and report, without publishing.
//
// Media must be on a public https URL (Meta fetches it). Flow per Meta docs: create container -> wait until FINISHED
// -> media_publish. Reels and carousel items are polled; images are usually ready at once.
const [kind, media, caption = "", ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry");
const cover = rest.includes("--cover") ? rest[rest.indexOf("--cover") + 1] : null;
const TOKEN = process.env.IG_TOKEN, IG = process.env.IG_USER_ID, V = "v26.0", API = `https://graph.instagram.com/${V}`;
if (!TOKEN || !IG) { console.error("IG_TOKEN / IG_USER_ID not set in the user environment"); process.exit(1); }
if (!kind || !media) { console.error("usage: node ig-post.mjs image|reel|carousel|story <url[,url]> [caption] [--dry] [--cover url]"); process.exit(1); }

const call = async (path, params, method = "POST") => {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = method === "GET" ? await fetch(`${API}/${path}?${body}`) : await fetch(`${API}/${path}`, { method, body });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error.message} (code ${j.error.code})`);
  return j;
};
const waitReady = async (id) => {
  for (let i = 0; i < 60; i++) {
    const s = await call(id, { fields: "status_code,status" }, "GET");
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR") throw new Error(`container ${id} failed: ${s.status}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`container ${id} not ready after 5 minutes`);
};

let containerId;
if (kind === "image") {
  containerId = (await call(`${IG}/media`, { image_url: media, caption })).id;
} else if (kind === "reel") {
  const p = { media_type: "REELS", video_url: media, caption, share_to_feed: "true" };
  if (cover) p.cover_url = cover;
  containerId = (await call(`${IG}/media`, p)).id;
  await waitReady(containerId);
} else if (kind === "story") {
  const isVideo = /\.mp4(\?|$)/i.test(media);
  containerId = (await call(`${IG}/media`, isVideo ? { media_type: "STORIES", video_url: media } : { media_type: "STORIES", image_url: media })).id;
  if (isVideo) await waitReady(containerId);
} else if (kind === "carousel") {
  const urls = media.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2 || urls.length > 10) throw new Error("carousel needs 2 to 10 urls");
  const children = [];
  for (const u of urls) {
    const isVideo = /\.mp4(\?|$)/i.test(u);
    const c = await call(`${IG}/media`, isVideo ? { media_type: "VIDEO", video_url: u, is_carousel_item: "true" } : { image_url: u, is_carousel_item: "true" });
    if (isVideo) await waitReady(c.id);
    children.push(c.id);
  }
  containerId = (await call(`${IG}/media`, { media_type: "CAROUSEL", children: children.join(","), caption })).id;
  await waitReady(containerId);
} else { console.error(`unknown kind ${kind}`); process.exit(1); }

if (dry) { console.log(`dry run: container ${containerId} ready, not published`); process.exit(0); }
const pub = await call(`${IG}/media_publish`, { creation_id: containerId });
const info = await call(pub.id, { fields: "permalink,timestamp" }, "GET");
console.log(`published ${kind}: ${info.permalink}`);
