// helpers.js - utilities for content_script.js

function safeJSONParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Attempt to find embedded page JSON from a few common places
function findInstagramPageJson() {
  try {
    if (window._sharedData) return window._sharedData;
    if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;
  } catch (e) {}

  const scripts = Array.from(document.scripts || []);
  for (const s of scripts) {
    const text = s.textContent || "";
    if (!text) continue;

    // application/ld+json
    if (s.type === "application/ld+json") {
      const parsed = safeJSONParse(text);
      if (parsed) return parsed;
    }

    // window._sharedData = {...}
    let m = text.match(/window\._sharedData\s*=\s*({[\s\S]*?});/);
    if (m && m[1]) {
      const parsed = safeJSONParse(m[1]);
      if (parsed) return parsed;
    }

    m = text.match(/window\.__additionalDataLoaded\(['"]profile['"],\s*({[\s\S]*?})\);/);
    if (m && m[1]) {
      const parsed = safeJSONParse(m[1]);
      if (parsed) return parsed;
    }

    // GraphQL-ish blocks—some pages embed a large JSON including "graphql"
    m = text.match(/({[\s\S]*"graphql"[\s\S]*})/);
    if (m && m[1]) {
      const parsed = safeJSONParse(m[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function getUsernameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 1) return parts[0];
  } catch (e) {}
  // fallback to meta tags (og:title often contains the username)
  const og = document.querySelector('meta[property="og:title"]');
  if (og && og.content) return og.content.split(" ")[0].replace("@", "");
  return null;
}

// deep search for key in object (first found)
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const k of Object.keys(obj)) {
    try {
      const res = deepFind(obj[k], key);
      if (res !== null && res !== undefined) return res;
    } catch (e) {}
  }
  return null;
}

// collect fallback DOM media (only as last resort)
function collectMediaFromDOM() {
  const results = [];
  const imgs = Array.from(document.querySelectorAll('img'));
  for (const img of imgs) {
    const src = img.currentSrc || img.src || img.getAttribute('src');
    if (src && isInstagramMedia(src)) results.push({ url: src, mediaType: 'image', filename: null });
  }
  const vids = Array.from(document.querySelectorAll('video'));
  for (const v of vids) {
    const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
    if (src && isInstagramMedia(src)) results.push({ url: src, mediaType: 'video', filename: null });
  }
  // dedupe by url
  const map = new Map();
  for (const r of results) if (!map.has(r.url)) map.set(r.url, r);
  return Array.from(map.values());
}

function isInstagramMedia(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes('cdninstagram.com') || u.hostname.includes('instagram') || /vp\//.test(u.pathname);
  } catch (e) { return false; }
}
