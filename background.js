(function () {
  "use strict";

  function sendShow(tabId) {
    chrome.tabs.sendMessage(tabId, { type: "SHOW_82_SOLVER" }, () => {
      chrome.runtime.lastError;
    });
  }

  function showAfterInject(tabId) {
    if (!chrome.scripting?.executeScript) return;
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["solver-core.js", "content.js"]
    }, () => {
      if (chrome.runtime.lastError) return;
      sendShow(tabId);
    });
  }

  chrome.action.onClicked.addListener((tab) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_82_SOLVER" }, (response) => {
      const missingContentScript = !!chrome.runtime.lastError;
      if (!missingContentScript && response?.ok) return;
      if (missingContentScript) setTimeout(() => showAfterInject(tab.id), 0);
    });
  });
})();
