// helpers.js - small utilities for the content script

function safeJSONParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// deep find (first match)
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const k of Object.keys(obj)) {
    try {
      const v = obj[k];
      const r = deepFind(v, key);
      if (r !== null && r !== undefined) return r;
    } catch (e) {}
  }
  return null;
}

// deepFindAll returns an array of matches
function deepFindAll(obj, key) {
  const results = [];
  (function recurse(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      try {
        const v = o[k];
        if (k === key) results.push(v);
        recurse(v);
      } catch (e) {}
    }
  })(obj);
  return results;
}

// try to pull embedded JSON blocks commonly used by Instagram
function findInstagramPageJson() {
  try {
    if (window._sharedData) return window._sharedData;
    if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;
  } catch (e) {}

  const scripts = Array.from(document.scripts || []);
  for (const s of scripts) {
    const text = s.textContent || '';
    if (!text) continue;

    if (s.type === 'application/ld+json') {
      const parsed = safeJSONParse(text);
      if (parsed) return parsed;
    }

    // window._sharedData = {...};
    let m = text.match(/window\._sharedData\s*=\s*({[\s\S]*?});/);
    if (m && m[1]) {
      const p = safeJSONParse(m[1]);
      if (p) return p;
    }

    // window.__additionalDataLoaded("profile", {...});
    m = text.match(/window\.__additionalDataLoaded\(['"]profile['"],\s*({[\s\S]*?})\);/);
    if (m && m[1]) {
      const p = safeJSONParse(m[1]);
      if (p) return p;
    }

    // big graphql blocks
    m = text.match(/({[\s\S]*"graphql"[\s\S]*})/);
    if (m && m[1]) {
      const p = safeJSONParse(m[1]);
      if (p) return p;
    }
  }

  return null;
}

function isLikelyInstagramMedia(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes('cdninstagram.com') || u.hostname.includes('instagram') || /vp\//.test(u.pathname);
  } catch (e) { return false; }
}
