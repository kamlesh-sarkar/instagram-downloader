chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes("instagram.com")) {
    return;
  }

  try {
    // 1. Show "..." badge on the toolbar icon and inject the on-page loading spinner
    await chrome.action.setBadgeBackgroundColor({ color: "#E1306C", tabId: tab.id });
    await chrome.action.setBadgeText({ text: "...", tabId: tab.id });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showLoadingToast,
      args: ["Fetching high-res media...", "loading"]
    });

    // 2. Run the extraction function
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractInstagramMedia
    });

    const response = results[0]?.result;

    if (response && response.urls && response.urls.length > 0) {
      // 3. Trigger downloads
      response.urls.forEach((media) => {
        chrome.downloads.download({
          url: media.url,
          filename: media.filename,
          saveAs: false
        });
      });

      // 4. Show success feedback
      await chrome.action.setBadgeBackgroundColor({ color: "#2ECC71", tabId: tab.id });
      await chrome.action.setBadgeText({ text: "✓", tabId: tab.id });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLoadingToast,
        args: [`Downloading ${response.urls.length} file(s)!`, "success"]
      });
    } else {
      // Show error feedback
      await chrome.action.setBadgeBackgroundColor({ color: "#E74C3C", tabId: tab.id });
      await chrome.action.setBadgeText({ text: "!", tabId: tab.id });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLoadingToast,
        args: [response?.error || "Could not extract media.", "error"]
      });
    }
  } catch (err) {
    console.error("Script injection failed:", err);
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "", tabId: tab.id }).catch(() => {});
    }, 2500);
  }
});

// Floating on-page loading/status toast
function showLoadingToast(message, state) {
  let toast = document.getElementById("ig-ext-loading-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ig-ext-loading-toast";
    toast.style.cssText = `
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 999999;
      background: rgba(20, 20, 20, 0.92);
      color: #ffffff;
      padding: 12px 18px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(8px);
      transition: opacity 0.3s ease;
    `;
    document.body.appendChild(toast);

    if (!document.getElementById("ig-ext-spinner-style")) {
      const style = document.createElement("style");
      style.id = "ig-ext-spinner-style";
      style.textContent = `@keyframes igExtSpin { to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }
  }

  toast.style.opacity = "1";

  if (state === "loading") {
    toast.innerHTML = `
      <div style="width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.25); border-top-color: #E1306C; border-radius: 50%; animation: igExtSpin 0.7s linear infinite;"></div>
      <span>${message}</span>
    `;
  } else {
    const icon = state === "success" ? "✅" : "⚠️";
    toast.innerHTML = `<span>${icon} ${message}</span>`;
    setTimeout(() => {
      if (toast) {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
      }
    }, 2200);
  }
}

// Main extraction function injected into Instagram
async function extractInstagramMedia() {
  const pathname = window.location.pathname;
  const headers = {
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest"
  };

  // Helper to grab highest-res video or image from an Instagram API node
  const getBestMedia = (node, baseName) => {
    if (node.video_versions && node.video_versions.length > 0) {
      return { url: node.video_versions[0].url, filename: `${baseName}.mp4` };
    }
    if (node.image_versions2?.candidates?.length > 0) {
      return { url: node.image_versions2.candidates[0].url, filename: `${baseName}.jpg` };
    }
    return null;
  };

  // ====================================================
  // 1. STORIES & HIGHLIGHTS (/stories/...)
  // ====================================================
  const storyMatch = pathname.match(/^\/stories\/([^\/]+)(?:\/(\d+))?/);
  if (storyMatch) {
    const usernameOrType = storyMatch[1]; // username or "highlights"
    const storyId = storyMatch[2];        // 19-digit story ID or highlight ID

    try {
      // A. Direct Story with numeric ID in URL (/stories/username/123456789/)
      if (usernameOrType !== "highlights" && storyId) {
        const res = await fetch(`https://www.instagram.com/api/v1/media/${storyId}/info/`, {
          headers,
          credentials: "include"
        });
        if (res.ok) {
          const data = await res.json();
          const item = data.items?.[0];
          if (item) {
            const media = getBestMedia(item, `ig_story_${usernameOrType}_${storyId}`);
            if (media) return { urls: [media] };
          }
        }
      }

      // B. Story Highlights (/stories/highlights/12345/) or Fallback via Reels Tray API
      let reelId = null;
      if (usernameOrType === "highlights" && storyId) {
        reelId = `highlight:${storyId}`;
      } else if (usernameOrType !== "highlights") {
        const profRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${usernameOrType}`, {
          headers,
          credentials: "include"
        });
        if (profRes.ok) {
          const profData = await profRes.json();
          reelId = profData?.data?.user?.id;
        }
      }

      if (reelId) {
        const reelRes = await fetch(`https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`, {
          headers,
          credentials: "include"
        });

        if (reelRes.ok) {
          const reelData = await reelRes.json();
          const items = reelData?.reels?.[reelId]?.items || reelData?.reels_media?.[0]?.items || [];

          if (items.length > 0) {
            let targetItem = null;

            // Match by storyId if present
            if (storyId && usernameOrType !== "highlights") {
              targetItem = items.find(it => String(it.pk) === storyId || String(it.id).startsWith(storyId));
            }

            // Otherwise, match the slide currently rendered on screen by comparing image/poster filenames
            if (!targetItem) {
              const domAssetNames = [
                ...Array.from(document.querySelectorAll("img")).map(img => img.src),
                ...Array.from(document.querySelectorAll("video")).map(vid => vid.poster)
              ]
                .filter(Boolean)
                .map(url => url.split("?")[0].split("/").pop());

              targetItem = items.find(it => {
                const candidates = it.image_versions2?.candidates || [];
                return candidates.some(c => {
                  const fileName = c.url.split("?")[0].split("/").pop();
                  return domAssetNames.includes(fileName);
                });
              });
            }

            // Default to first slide if no match found
            if (!targetItem) targetItem = items[0];

            const media = getBestMedia(targetItem, `ig_story_${usernameOrType}_${targetItem.pk || Date.now()}`);
            if (media) return { urls: [media] };
          }
        }
      }
    } catch (e) {
      console.warn("Story API extraction failed, attempting DOM fallback...", e);
    }

    // Story DOM Fallback (grabs visible photo story from screen)
    const storyImgs = Array.from(document.querySelectorAll("img"))
      .filter(img => img.naturalWidth > 300 && img.getBoundingClientRect().width > 150);
    if (storyImgs.length > 0) {
      storyImgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      return { urls: [{ url: storyImgs[0].src, filename: `ig_story_${usernameOrType}.jpg` }] };
    }

    return { error: "Could not extract Story. Make sure you are logged in and viewing an active Story." };
  }

  // ====================================================
  // 2. POSTS, REELS & CAROUSELS (/p/, /reel/, /tv/)
  // ====================================================
  const postMatch = pathname.match(/\/(p|reels?|tv)\/([A-Za-z0-9_-]+)/);
  if (!postMatch) {
    return {
      error: "Open a Post, Reel, or Story first so its link is active in your address bar."
    };
  }

  const shortcode = postMatch[2];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = 0n;
  for (const char of shortcode) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    mediaId = (mediaId * 64n) + BigInt(index);
  }

  try {
    const apiUrl = `https://www.instagram.com/api/v1/media/${mediaId.toString()}/info/`;
    const res = await fetch(apiUrl, { headers, credentials: "include" });

    if (res.ok) {
      const data = await res.json();
      const item = data.items?.[0];

      if (item) {
        const urls = [];
        if (item.carousel_media && item.carousel_media.length > 0) {
          item.carousel_media.forEach((slide, idx) => {
            const media = getBestMedia(slide, `ig_${shortcode}_${idx + 1}`);
            if (media) urls.push(media);
          });
        } else {
          const media = getBestMedia(item, `ig_${shortcode}`);
          if (media) urls.push(media);
        }

        if (urls.length > 0) return { urls };
      }
    }
  } catch (e) {
    console.warn("Post API fetch failed, attempting DOM fallback...", e);
  }

  // Post DOM Fallback
  const article = document.querySelector("article") || document.body;
  const imgs = Array.from(article.querySelectorAll("img")).filter(img => img.naturalWidth > 300);
  if (imgs.length > 0) {
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    return { urls: [{ url: imgs[0].src, filename: `ig_${shortcode}.jpg` }] };
  }

  return { error: "Could not extract media. Ensure you are logged into Instagram." };
}
