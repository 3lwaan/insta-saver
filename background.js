// background.js - MV3 service worker for InstaSaver EDU
// NOTE: Requires lib/jszip.min.js (download & place into extension/lib/jszip.min.js)

try {
  importScripts('lib/jszip.min.js');
  console.log('JSZip loaded?', typeof JSZip);
} catch (e) {
  console.warn('Could not import JSZip. Make sure lib/jszip.min.js exists.', e);
}

// Create context menu limited to Instagram pages
const PARENT_ID = 'instasaver_edu_parent';
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT_ID,
      title: 'InstaSaver EDU',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.instagram.com/*']
    });

    const items = [
      { id: 'all', title: 'Download all media (zip)' },
      { id: 'images', title: 'Download image posts (zip)' },
      { id: 'reels', title: 'Download reels (zip)' },
      { id: 'stories', title: 'Download stories (zip or fallback)' },
      { id: 'highlights', title: 'Download highlights (zip or fallback)' },
      { id: 'profile_pic', title: 'Download profile picture (single file)' }
    ];

    for (const it of items) {
      chrome.contextMenus.create({
        id: it.id,
        parentId: PARENT_ID,
        title: it.title,
        contexts: ['page'],
        documentUrlPatterns: ['https://www.instagram.com/*']
      });
    }
  });
});

// Utility: promisified sendMessage to a tab
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

// Utility: inject content scripts into a tab (helpers.js then content_script.js)
function injectContentScripts(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: ['helpers.js', 'content_script.js']
  });
}

function sanitizeFilename(name) {
  return (name || 'unknown').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
}

function pathSafe(name) {
  return sanitizeFilename(name).replace(/\s+/g, '_');
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const extMatch = last.match(/\.[a-z0-9]+$/i);
    const ext = extMatch ? extMatch[0] : '';
    const base = last.replace(/\.[a-z0-9]+$/i, '') || `file-${Date.now()}`;
    return `${base}${ext}`;
  } catch (e) {
    return `file-${Date.now()}`;
  }
}

// fetch with timeout helper
async function fetchArrayBufferWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(id);
  }
}

// Handler for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const action = info.menuItemId; // one of 'all', 'images', 'reels', 'stories', 'highlights', 'profile_pic'
  try {
    // First attempt to message existing content script
    let resp;
    try {
      resp = await sendMessageToTab(tab.id, { type: 'gather_media', action });
    } catch (err) {
      // If not present, inject content scripts and try again
      console.warn('Content script absent or not responding; injecting...', err && err.message);
      try {
        await injectContentScripts(tab.id);
        // small delay to allow script to initialize (usually immediate)
        resp = await sendMessageToTab(tab.id, { type: 'gather_media', action });
      } catch (err2) {
        console.error('Failed to inject or talk to content script:', err2);
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'InstaSaver EDU',
          message: 'Could not communicate with the page. Make sure you are on an Instagram profile page and reload it.'
        });
        return;
      }
    }

    if (!resp || !resp.ok) {
      const reason = resp && resp.reason ? resp.reason : 'No media found or page not supported.';
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: `Failed: ${reason}`
      });
      return;
    }

    const username = pathSafe(resp.username || 'instagram_user');
    const media = Array.isArray(resp.media) ? resp.media : [];
    if (media.length === 0) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: 'No media URLs found for this option.'
      });
      return;
    }

    // PROFILE PIC -> direct download (no zip)
    if (action === 'profile_pic') {
      const item = media[0];
      const url = item.url;
      if (!url) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'InstaSaver EDU',
          message: 'Profile picture URL missing.'
        });
        return;
      }
      const fname = filenameFromUrl(url) || `profile_${username}.jpg`;
      const path = `InstagramDownloads/${username}/profile/${fname}`;
      await chrome.downloads.download({ url, filename: path, conflictAction: 'uniquify', saveAs: false });
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: 'Profile picture download started.'
      });
      return;
    }

    // BULK: create zip using JSZip if available
    if (typeof JSZip === 'undefined') {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: 'Missing JSZip library. Place lib/jszip.min.js in the extension folder.'
      });
      return;
    }

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'InstaSaver EDU',
      message: `Preparing ${media.length} items for ${action}...`
    });

    const zip = new JSZip();
    const subFolder = `${username}/${action}`;
    let added = 0;
    const fallback = []; // urls we couldn't fetch (will be downloaded individually)

    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      const url = m.url;
      if (!url) continue;
      const suggested = m.filename || filenameFromUrl(url) || `${action}_${i+1}`;
      const zipPath = `${subFolder}/${suggested}`;
      try {
        const ab = await fetchArrayBufferWithTimeout(url, 25000);
        zip.file(zipPath, ab);
        added++;
      } catch (err) {
        console.warn('Could not fetch for zip, will fallback to direct download:', url, err && err.message);
        fallback.push({ url, suggested });
      }
    }

    // If we added files into zip, generate and download zip as base64 data URL
    if (added > 0) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: `Creating zip with ${added} files...`
      });
      const base64 = await zip.generateAsync({ type: 'base64' });
      const dataUrl = 'data:application/zip;base64,' + base64;
      const zipName = `InstagramDownloads_${username}_${action}_${Date.now()}.zip`;
      await chrome.downloads.download({
        url: dataUrl,
        filename: zipName,
        conflictAction: 'uniquify',
        saveAs: false
      });
    }

    // For fallback items, download them individually using chrome.downloads.download
    if (fallback.length > 0) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'InstaSaver EDU',
        message: `${fallback.length} file(s) could not be fetched for zipping. They will be downloaded individually.`
      });

      for (const fb of fallback) {
        const p = `InstagramDownloads/${username}/${action}/${fb.suggested}`;
        try {
          await chrome.downloads.download({ url: fb.url, filename: p, conflictAction: 'uniquify', saveAs: false });
        } catch (err) {
          console.error('Fallback download failed:', fb.url, err);
        }
      }
    }

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'InstaSaver EDU',
      message: `Done. Zipped: ${added}. Fallback downloads: ${fallback.length}.`
    });

  } catch (err) {
    console.error('Context menu handler error:', err);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'InstaSaver EDU',
      message: `Unexpected error: ${String(err)}`
    });
  }
});
