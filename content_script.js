// content_script.js - extracts structured media URLs from Instagram profile pages
// Assumes helpers.js is injected before this file (via manifest or dynamic injection)

console.log('InstaSaver EDU - content script loaded');

// Get username from URL / OG meta
function getUsernameFromUrl() {
  try {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length >= 1) return parts[0];
  } catch (e) {}
  const og = document.querySelector('meta[property="og:title"]');
  if (og && og.content) return og.content.split(' ')[0].replace('@', '');
  return null;
}

function collectFromTimelineJson(pageJson) {
  const items = [];
  try {
    const user = pageJson && pageJson.entry_data && pageJson.entry_data.ProfilePage && pageJson.entry_data.ProfilePage[0] && pageJson.entry_data.ProfilePage[0].graphql && pageJson.entry_data.ProfilePage[0].graphql.user
      || (pageJson && pageJson.graphql && pageJson.graphql.user)
      || (pageJson && pageJson.user);

    if (!user) return items;
    const edges = user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges ? user.edge_owner_to_timeline_media.edges : null;
    const nodes = edges ? edges.map(e => e.node) : (user.media && user.media.nodes ? user.media.nodes : []);
    for (const node of nodes) {
      if (!node) continue;
      // carousel
      if (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges) {
        for (const c of node.edge_sidecar_to_children.edges) {
          const cn = c.node;
          const url = cn.video_url || cn.display_url || (cn.image_versions2 && cn.image_versions2.candidates && cn.image_versions2.candidates[0] && cn.image_versions2.candidates[0].url) || null;
          if (url) items.push({ url, mediaType: cn.is_video ? 'video' : 'image', filename: `${node.shortcode || node.id}_carousel_item.jpg` });
        }
      } else {
        const url = node.video_url || node.display_url || (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates[0] && node.image_versions2.candidates[0].url) || null;
        if (url) {
          const type = node.is_video ? 'video' : 'image';
          const fname = (node.shortcode ? `${node.shortcode}` : `${node.id || 'post'}${type === 'video' ? '.mp4' : '.jpg'}`);
          items.push({ url, mediaType: type, filename: fname });
        }
      }
    }
  } catch (e) { console.warn('collectFromTimelineJson error', e); }
  return items;
}

function collectReelsFromJson(pageJson) {
  const items = [];
  // Many reels are present as part of timeline nodes (is_video), so reuse that.
  try {
    // try reels_media blocks
    const reels = deepFindAll(pageJson, 'reels_media').flat();
    for (const r of reels) {
      if (!r) continue;
      if (Array.isArray(r)) {
        for (const item of r) {
          const v = item.video_versions && item.video_versions[0] && item.video_versions[0].url;
          const u = item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates[0] && item.image_versions2.candidates[0].url;
          if (v) items.push({ url: v, mediaType: 'video', filename: `${item.pk || 'reel'}.mp4` });
          else if (u) items.push({ url: u, mediaType: 'image', filename: `${item.pk || 'reel'}.jpg` });
        }
      }
    }
  } catch (e) { console.warn('collectReelsFromJson error', e); }
  return items;
}

function collectStoriesFromJson(pageJson) {
  const items = [];
  try {
    const reels = deepFindAll(pageJson, 'reels_media').flat();
    for (const r of reels) {
      if (!r) continue;
      if (Array.isArray(r)) {
        for (const item of r) {
          const v = item.video_versions && item.video_versions[0] && item.video_versions[0].url;
          const u = item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates[0] && item.image_versions2.candidates[0].url;
          if (v) items.push({ url: v, mediaType: 'video', filename: `${item.pk || 'story'}.mp4` });
          else if (u) items.push({ url: u, mediaType: 'image', filename: `${item.pk || 'story'}.jpg` });
        }
      }
    }
  } catch (e) { console.warn('collectStoriesFromJson error', e); }
  return items;
}

// fallback DOM scanning but with heuristics to avoid UI icons
function collectMediaFromDOM() {
  const results = [];
  // Prefer images inside article (posts area)
  const article = document.querySelector('article');
  const containers = article ? [article] : [document];
  for (const root of containers) {
    const imgs = Array.from(root.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute('src');
      if (src && isLikelyInstagramMedia(src)) {
        results.push({ url: src, mediaType: 'image', filename: null });
      }
    }
    const vids = Array.from(root.querySelectorAll('video'));
    for (const v of vids) {
      const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
      if (src && isLikelyInstagramMedia(src)) results.push({ url: src, mediaType: 'video', filename: null });
    }
  }
  // dedupe
  const map = new Map();
  for (const r of results) if (!map.has(r.url)) map.set(r.url, r);
  return Array.from(map.values());
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'gather_media') return;
  (async () => {
    try {
      const action = msg.action || 'all';
      const username = getUsernameFromUrl() || document.querySelector('meta[property="og:title"]')?.content?.split(' ')[0]?.replace('@', '') || null;
      if (!username) {
        sendResponse({ ok: false, reason: 'Cannot detect username from URL', username: null });
        return;
      }

      const pageJson = findInstagramPageJson();

      const results = [];
      const addUnique = (o) => {
        if (!o || !o.url) return;
        if (!results.some(x => x.url === o.url)) results.push(o);
      };

      // Profile picture
      if (action === 'profile_pic' || action === 'all') {
        const meta = document.querySelector('meta[property="og:image"]');
        if (meta && meta.content) addUnique({ url: meta.content, filename: `profile_${username}.jpg`, mediaType: 'profile_pic' });
        else if (pageJson) {
          const p = deepFind(pageJson, 'profile_pic_url_hd') || deepFind(pageJson, 'profile_pic_url');
          if (p) addUnique({ url: p, filename: `profile_${username}.jpg`, mediaType: 'profile_pic' });
        }
      }

      // Posts / timeline
      if (['images', 'reels', 'all'].includes(action)) {
        const timeline = collectFromTimelineJson(pageJson);
        for (const t of timeline) addUnique(t);
      }

      // Reels (best-effort)
      if (['reels', 'all'].includes(action)) {
        const reels = collectReelsFromJson(pageJson);
        for (const r of reels) addUnique(r);
      }

      // Stories / Highlights (best-effort)
      if (['stories', 'highlights', 'all'].includes(action)) {
        const stories = collectStoriesFromJson(pageJson);
        for (const s of stories) addUnique(s);

        // fallback: highlight thumbnails / visible story thumbnails in DOM (but filter)
        const thumbs = Array.from(document.querySelectorAll('a[href*="/stories/"], a[href*="/highlights/"] img, div[role="button"] img'));
        for (const img of thumbs) {
          const src = img.currentSrc || img.src;
          if (src && isLikelyInstagramMedia(src)) addUnique({ url: src, mediaType: 'image', filename: null });
        }
      }

      // Final fallback: DOM scan (if still empty)
      if (results.length === 0) {
        const dom = collectMediaFromDOM();
        for (const d of dom) addUnique(d);
      }

      // Prepare final entries with filenames
      const final = results.map((m, idx) => {
        const urlExt = (m.url && m.url.split('.').pop().split('?')[0]) || '';
        const useExt = (urlExt && urlExt.length <= 5) ? '.' + urlExt : (m.mediaType && m.mediaType.includes('video') ? '.mp4' : '.jpg');
        const fname = m.filename || `${action}_${idx + 1}${useExt}`;
        return { url: m.url, filename: fname, mediaType: m.mediaType || 'media' };
      });

      sendResponse({ ok: true, username, media: final });
    } catch (err) {
      console.error('content_script gather_media error', err);
      sendResponse({ ok: false, reason: String(err) });
    }
  })();

  return true; // will respond asynchronously
});
