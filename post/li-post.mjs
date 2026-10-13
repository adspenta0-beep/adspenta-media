// Publish to Mark's LinkedIn profile through LinkedIn's own versioned API (no third party).
// Token and person URN come from env vars LINKEDIN_TOKEN and LINKEDIN_PERSON_URN; nothing is printed or stored.
//
//   node li-post.mjs text     "<text>"                                  [--comment "<first comment>"]
//   node li-post.mjs image    "<public image url>"      "<text>"       [--comment ...] [--alt "..."]
//   node li-post.mjs images   "<url1>,<url2>,..."       "<text>"       [--comment ...]   (2 to 20 images)
//   node li-post.mjs video    "<public mp4 url>"        "<text>"       [--comment ...] [--title "..."]
//   node li-post.mjs document "<public pdf url>"        "<text>"       --title "<doc title>" [--comment ...]
//   add --dry to validate and download the media without creating anything.
//
// Flow (LinkedIn docs, Marketing version 202609): images/documents: initializeUpload -> PUT bytes; videos:
// initializeUpload (fileSizeBytes) -> PUT each 4 MB part, keep the ETags -> finalizeUpload -> poll until AVAILABLE;
// then POST /rest/posts (author = person URN, PUBLIC, MAIN_FEED, PUBLISHED); the post id comes back in x-restli-id.
// The post is read back before "posted" is reported. The first comment goes through /rest/socialActions.
const VERSION = "202609"; // active LinkedIn-Version (YYYYMM); each version lives about a year. Check learn.microsoft.com/linkedin/marketing/versioning before changing.
const argv = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dry") opt.dry = true;
  else if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [kind, a, b] = pos;
const text = kind === "text" ? a : (b ?? ""), media = kind === "text" ? null : a;
const TOKEN = process.env.LINKEDIN_TOKEN, AUTHOR = process.env.LINKEDIN_PERSON_URN;
if (!TOKEN || !AUTHOR) { console.error("LINKEDIN_TOKEN / LINKEDIN_PERSON_URN not set"); process.exit(1); }
if (!kind || (kind !== "text" && !media) || !text) { console.error("usage: node li-post.mjs text|image|images|video|document <url|text> [text] [--comment c] [--title t] [--dry]"); process.exit(1); }
if (/[–—]/.test(text + (opt.comment ?? ""))) { console.error("text contains an en or em dash; fix the copy"); process.exit(1); }
console.log(`LinkedIn-Version ${VERSION}`);

const H = { Authorization: `Bearer ${TOKEN}`, "LinkedIn-Version": VERSION, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
const api = async (path, body, method = "POST", extra = {}) => {
  const r = await fetch(`https://api.linkedin.com/rest/${path}`, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${r.status}: ${t.slice(0, 300)}`);
  return { id: r.headers.get("x-restli-id"), json: t ? JSON.parse(t) : {} };
};
const fetchBytes = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`media ${url} -> ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
const put = async (url, bytes, extra = {}) => {
  const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream", ...extra }, body: bytes });
  if (!r.ok) throw new Error(`upload -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.headers.get("etag");
};
const enc = (urn) => encodeURIComponent(urn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uploadImage = async (url) => {
  const bytes = await fetchBytes(url);
  if (opt.dry) return `dry:image:${bytes.length}B`;
  const { json } = await api("images?action=initializeUpload", { initializeUploadRequest: { owner: AUTHOR } });
  await put(json.value.uploadUrl, bytes);
  return json.value.image;
};
const uploadDocument = async (url) => {
  const bytes = await fetchBytes(url);
  if (opt.dry) return `dry:document:${bytes.length}B`;
  const { json } = await api("documents?action=initializeUpload", { initializeUploadRequest: { owner: AUTHOR } });
  await put(json.value.uploadUrl, bytes);
  return json.value.document;
};
const uploadVideo = async (url) => {
  const bytes = await fetchBytes(url);
  if (opt.dry) return `dry:video:${bytes.length}B`;
  const { json } = await api("videos?action=initializeUpload", { initializeUploadRequest: { owner: AUTHOR, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } });
  const v = json.value, etags = [];
  for (const part of v.uploadInstructions) etags.push(await put(part.uploadUrl, bytes.subarray(part.firstByte, part.lastByte + 1)));
  await api("videos?action=finalizeUpload", { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } });
  for (let i = 0; i < 60; i++) {
    const { json: s } = await api(`videos/${enc(v.video)}`, null, "GET");
    if (s.status === "AVAILABLE") return v.video;
    if (s.status === "PROCESSING_FAILED") throw new Error(`video processing failed: ${s.processingFailureReason ?? ""}`);
    await sleep(5000);
  }
  throw new Error("video not AVAILABLE after 5 minutes");
};

let content;
if (kind === "image") content = { media: { id: await uploadImage(media), ...(opt.alt ? { altText: opt.alt } : {}) } };
else if (kind === "images") {
  const urls = media.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2 || urls.length > 20) throw new Error("images needs 2 to 20 urls");
  const ids = []; for (const u of urls) ids.push({ id: await uploadImage(u) });
  content = { multiImage: { images: ids } };
} else if (kind === "video") content = { media: { id: await uploadVideo(media), title: opt.title ?? "Video" } };
else if (kind === "document") { if (!opt.title) throw new Error("document needs --title"); content = { media: { id: await uploadDocument(media), title: opt.title } }; }
else if (kind !== "text") { console.error(`unknown kind ${kind}`); process.exit(1); }

if (opt.dry) { console.log(`dry run: ${kind} ok (${content ? JSON.stringify(content).slice(0, 80) : "text only"}), nothing created`); process.exit(0); }

const body = { author: AUTHOR, commentary: text, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false };
if (content) body.content = content;
const { id: postUrn } = await api("posts", body);
if (!postUrn) throw new Error("post created but no x-restli-id returned; check the profile before retrying");
let state = "";
for (let i = 0; i < 12; i++) { // read back: a media post can sit in PUBLISH_REQUESTED for a few seconds
  const { json } = await api(`posts/${enc(postUrn)}?viewContext=AUTHOR`, null, "GET");
  state = json.lifecycleState; if (state === "PUBLISHED") break; if (state === "PUBLISH_FAILED") throw new Error("post PUBLISH_FAILED"); await sleep(5000);
}
if (opt.comment) {
  await sleep(3000);
  await api(`socialActions/${enc(postUrn)}/comments`, { actor: AUTHOR, object: postUrn, message: { text: opt.comment } });
}
const url = `https://www.linkedin.com/feed/update/${postUrn}/`;
console.log(`published ${kind}: ${url}${opt.comment ? " (+ first comment)" : ""}`);
