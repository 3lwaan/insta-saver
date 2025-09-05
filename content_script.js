// content_script.js - collects structured media URLs for the requested action
// Runs in page context (content script environment)

// Listen for gather_media messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'gather_media') return;
  (async () => {
    try {
      const action = msg.action || 'all';
      const pageUrl = window.location.href;
      const username = getUsernameFromUrl(pageUrl) || detectUsernameFromMeta() || null;
      if (!username) {
        sendResponse({ ok: false, reason: 'Cannot detect username', username: null });
        return;
      }

      const pageJson = findInstagramPageJson();

      // media items we will return: { url, filename?, mediaType }
      const media = [];
      const addUnique = (m) => {
        if (!m || !m.url) return;
        if (!media.some(x => x.url === m.url)) media.push(m);
      };

      // 1) Profile picture (always try)
      if (action === 'profile_pic' || action === 'all') {
        const og = document.querySelector('meta[property="og:image"]');
        if (og && og.content) addUnique({ url: og.content, filename: `profile_${username}.jpg`, mediaType: 'profile_pic' });
        else if (pageJson) {
          const p = deepFind(pageJson, 'profile_pic_url_hd') || deepFind(pageJson, 'profile_pic_url');
          if (p) addUnique({ url: p, filename: `profile_${username}.jpg`, mediaType: 'profile_pic' });
        }
      }

      // 2) Posts/Reels from GraphQL-style JSON
      if (['images', 'reels', 'all'].includes(action)) {
        let nodes = [];
        try {
          const user =
            (pageJson && pageJson.entry_data && pageJson.entry_data.ProfilePage && pageJson.entry_data.ProfilePage[0] && pageJson.entry_data.ProfilePage[0].graphql && pageJson.entry_data.ProfilePage[0].graphql.user)
            || (pageJson && pageJson.graphql && pageJson.graphql.user)
            || (pageJson && pageJson.user);

          if (user && user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) {
            nodes = user.edge_owner_to_timeline_media.edges.map(e => e.node);
          } else if (user && user.media && user.media.nodes) {
            nodes = user.media.nodes;
          }
        } catch (e) { /* ignore */ }

        for (const node of nodes) {
          try {
            // carousel
            if (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges) {
              for (const c of node.edge_sidecar_to_children.edges) {
                const cn = c.node;
                const url = cn.video_url || cn.display_url || cn.display_src || (cn.image_versions2 && cn.image_versions2.candidates && cn.image_versions2.candidates[0] && cn.image_versions2.candidates[0].url);
                if (url) addUnique({ url, mediaType: cn.is_video ? 'video' : 'image', filename: null });
              }
            } else {
              const url = node.video_url || node.display_url || node.display_src || (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates[0] && node.image_versions2.candidates[0].url);
              if (url) {
                addUnique({ url, mediaType: node.is_video ? 'video' : 'image', filename: null });
              }
            }
          } catch (e) {}
        }

        // Fallback: if nothing found in JSON, scan DOM for article images/videos
        if (media.length === 0) {
          const domMedia = collectMediaFromDOM();
          for (const m of domMedia) addUnique(m);
        }
      }

      // 3) Reels (in addition to posts above, include videos found in DOM)
      if (action === 'reels') {
        const vids = Array.from(document.querySelectorAll('video'));
        for (const v of vids) {
          const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
          if (src) addUnique({ url: src, mediaType: 'video', filename: null });
        }
      }

      // 4) Stories & Highlights (best-effort)
      if (['stories', 'highlights', 'all'].includes(action)) {
        // highlight thumbnails
        const highlightImgs = Array.from(document.querySelectorAll('header ~ section div a img, div[role="button"] img, a[href*="/stories/"] img'));
        for (const im of highlightImgs) {
          const src = im.currentSrc || im.src;
          if (src) addUnique({ url: src, mediaType: 'image', filename: null });
        }

        // pageJson sometimes contains reels_media or story blocks
        if (pageJson) {
          const reels = deepFindAll(pageJson, 'reels_media').flat();
          for (const r of reels) {
            if (Array.isArray(r)) {
              for (const item of r) {
                const u = item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates[0] && item.image_versions2.candidates[0].url;
                const v = item.video_versions && item.video_versions[0] && item.video_versions[0].url;
                if (v) addUnique({ url: v, mediaType: 'video', filename: null });
                if (u) addUnique({ url: u, mediaType: 'image', filename: null });
              }
            }
          }
        }
      }

      // Finalize filenames and types
      const final = media.map((m, idx) => {
        const ext = (m.mediaType && m.mediaType.includes('video')) ? '.mp4' : '.jpg';
        const urlExt = (m.url && m.url.split('.').pop().split('?')[0]) || '';
        const useExt = (urlExt && urlExt.length <= 5) ? '.' + urlExt : ext;
        const filename = m.filename || `${action}_${idx + 1}${useExt}`;
        return { url: m.url, filename, mediaType: m.mediaType || 'media' };
      });

      sendResponse({ ok: true, username, media: final });
    } catch (err) {
      console.error('gather_media error:', err);
      sendResponse({ ok: false, reason: String(err) });
    }
  })();
  return true; // asynchronous response
});

// small helpers used here (re-use helpers.js definitions if needed)
function detectUsernameFromMeta() {
  const og = document.querySelector('meta[property="og:title"]');
  if (og && og.content) return og.content.split(' ')[0].replace('@', '');
  return null;
}
