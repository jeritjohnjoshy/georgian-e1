let captureState = "idle";
const TYPE_DELAY_MS = 75;
const LOCAL_API_URL = "http://127.0.0.1:8000";

async function setCaptureState(state, error = "") {
  captureState = state;
  await chrome.storage.session.set({ captureState });
  chrome.runtime.sendMessage({ type: "CAPTURE_STATE", state, error }).catch(() => {});
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture and transcribe audio from the active browser tab.",
    });
  }
}

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function typeTextWithKeyboard(tabId, text) {
  const target = { tabId };
  let attached = false;
  let typed = 0;
  try {
    await debuggerCall("attach", target, "1.3");
    attached = true;

    for (const character of Array.from(text)) {
      const isSpace = character === " ";
      const keyOptions = {
        key: isSpace ? " " : character,
        code: isSpace ? "Space" : "Unidentified",
        windowsVirtualKeyCode: isSpace ? 32 : 0,
        nativeVirtualKeyCode: isSpace ? 32 : 0,
      };

      await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        ...keyOptions,
      });
      try {
        await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
          type: "char",
          ...keyOptions,
          text: character,
          unmodifiedText: character,
        });
      } finally {
        await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
          type: "keyUp",
          ...keyOptions,
        });
      }

      typed += 1;
      await delay(TYPE_DELAY_MS);
    }
    return { complete: true, typed };
  } catch (error) {
    return { complete: false, typed, error: error.message };
  } finally {
    if (attached) await debuggerCall("detach", target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_ASR_MODELS") {
    fetch(`${LOCAL_API_URL}/models`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "Could not get the available models.");
        sendResponse(result);
      })
      .catch((error) => sendResponse({ error: error.message || "Could not connect to the model API." }));
    return true;
  }

  if (message.type === "SELECT_ASR_MODEL") {
    fetch(`${LOCAL_API_URL}/models/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: message.modelId }),
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "Could not load the selected model.");
        sendResponse(result);
      })
      .catch((error) => sendResponse({ error: error.message || "Could not select the model." }));
    return true;
  }

  if (message.type === "GET_CAPTURE_STATE") {
    chrome.storage.session.get("captureState").then((stored) => {
      captureState = stored.captureState || "idle";
      sendResponse({ state: captureState });
    });
    return true;
  }

  if (message.type === "START_CAPTURE") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId == null) throw new Error("Open the overlay on a regular website tab first.");
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START_CAPTURE",
          streamId,
          tabId,
        });
        await setCaptureState("listening");
        sendResponse({ ok: true });
      } catch (error) {
        await setCaptureState("idle", error.message || "Could not start tab capture.");
        sendResponse({ error: error.message || "Could not start tab capture." });
      }
    })();
    return true;
  }

  if (message.type === "CAPTURE_ACTIVITY") {
    setCaptureState(message.state);
    if (message.tabId != null) {
      chrome.tabs.sendMessage(message.tabId, { type: "CAPTURE_STATE", state: message.state }).catch(() => {});
    }
    return false;
  }

  if (message.type === "STOP_CAPTURE") {
    setCaptureState("stopping").then(() => {
      chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GENERATE_TRANSCRIPTION") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId == null) throw new Error("Open the overlay on the chat tab before generating text.");
        await ensureOffscreenDocument();
        await setCaptureState("generating");
        const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "GENERATE_TRANSCRIPTION", tabId });
        if (result?.error) throw new Error(result.error);
        console.info("[Georgian Audio] Offscreen accepted transcription request");
        sendResponse({ ok: true });
      } catch (error) {
        console.error("[Georgian Audio] Could not dispatch transcription request:", error);
        await setCaptureState("idle", error.message || "Could not reach the audio recorder.");
        sendResponse({ error: error.message || "Could not reach the audio recorder." });
      }
    })();
    return true;
  }

  if (message.type === "OCR_SCREEN_AREA") {
    (async () => {
      try {
        const tab = sender.tab;
        if (tab?.id == null || tab.windowId == null) {
          throw new Error("Open the overlay on a regular website tab before selecting a screen area.");
        }
        console.info("[Georgian Audio] Capturing visible tab for selected screen area", tab.id);
        const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        await chrome.tabs.sendMessage(tab.id, { type: "SCREEN_CAPTURE_TAKEN" });
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OCR_SCREEN_IMAGE",
          tabId: tab.id,
          screenshot,
          region: message.region,
          viewport: message.viewport,
        });
        if (result?.error) throw new Error(result.error);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ error: error.message || "Could not capture the selected screen area." });
      }
    })();
    return true;
  }

  if (message.type === "TYPE_TEXT") {
    const tabId = sender.tab?.id;
    if (tabId == null || typeof message.text !== "string" || message.text.length > 5000) {
      sendResponse({ error: "Could not type this text into the active page." });
      return false;
    }
    typeTextWithKeyboard(tabId, message.text).then(sendResponse);
    return true;
  }

  if (message.type === "TRANSCRIPTION_RESULT") {
    setCaptureState(message.retryable ? "recorded" : "idle", message.error || "");
    chrome.tabs.sendMessage(message.tabId, {
      type: "TRANSCRIPTION_RESULT",
      text: message.text,
      error: message.error,
      retryable: message.retryable,
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SCREEN_OCR_RESULT") {
    chrome.tabs.sendMessage(message.tabId, {
      type: "SCREEN_OCR_RESULT",
      text: message.text,
      error: message.error,
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
});