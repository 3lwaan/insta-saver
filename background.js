// background.js - InstaSaver EDU (Manifest V3)
// Load JSZip library (must exist in lib/jszip.min.js)
importScripts('lib/jszip.min.js');

console.log("JSZip loaded?", typeof JSZip);

// Context menu creation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "instaSaver",
    title: "InstaSaver EDU",
    contexts: ["all"]
  });

  const subMenus = [
    { id: "downloadAll", title: "Download all media" },
    { id: "downloadPosts", title: "Download image posts" },
    { id: "downloadReels", title: "Download reels (videos)" },
    { id: "downloadStories", title: "Download stories" },
    { id: "downloadHighlights", title: "Download highlights" },
    { id: "downloadProfilePic", title: "Download profile picture" }
  ];

  subMenus.forEach(item => {
    chrome.contextMenus.create({
      id: item.id,
      parentId: "instaSaver",
      title: item.title,
      contexts: ["all"]
    });
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  const action = info.menuItemId;

  try {
    // Ask content script for media links
    const response = await chrome.tabs.sendMessage(tab.id, { action });

    if (!response || !response.media || response.media.length === 0) {
      console.warn("No media found for", action);
      return;
    }

    // Profile picture = direct .jpg download
    if (action === "downloadProfilePic") {
      const fileUrl = response.media[0].url;
      const username = response.username || "instagram_user";

      chrome.downloads.download({
        url: fileUrl,
        filename: `InstagramDownloads/${username}/profile_picture.jpg`
      });
      return;
    }

    // Otherwise: bundle into a ZIP
    const username = response.username || "instagram_user";
    const zip = new JSZip();

    for (let i = 0; i < response.media.length; i++) {
      const media = response.media[i];
      const filename = `${action}_${i + 1}${media.type === "video" ? ".mp4" : ".jpg"}`;

      try {
        const blob = await fetchMediaAsBlob(media.url);
        zip.file(filename, blob);
      } catch (err) {
        console.error("Failed to fetch media", media.url, err);
      }
    }

    // Generate ZIP and download
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const zipUrl = URL.createObjectURL(zipBlob);

    chrome.downloads.download({
      url: zipUrl,
      filename: `InstagramDownloads/${username}/${action}.zip`,
      saveAs: false
    });

    console.log(`ZIP created for ${action} (${response.media.length} files)`);

  } catch (err) {
    console.error("Error handling context menu action:", action, err);
  }
});

// Helper: fetch a URL as Blob
async function fetchMediaAsBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.blob();
}
