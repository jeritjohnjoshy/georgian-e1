(() => {
if (window.__georgianAudioContentLoaded) return;
window.__georgianAudioContentLoaded = true;

let overlayHost;
let selectedField = null;
let mostRecentlyFocusedField = isEditable(document.activeElement) ? document.activeElement : null;
let choosingField = false;
let captureState = "idle";
let modelSwitching = false;

function isEditable(element) {
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && ["text", "search", "email", "url", "tel"].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function getLingwingInputField() {
  if (!document.querySelector("#chatPageWrapper")) return null;
  const field = document.querySelector('textarea[title="Input"][aria-label="input"]');
  return isEditable(field) ? field : null;
}

document.addEventListener("focusin", (event) => {
  if (isEditable(event.target)) mostRecentlyFocusedField = event.target;
}, true);

function renderWorkflow() {
  if (!overlayHost?.isConnected) return;
  const shadow = overlayHost.shadowRoot;
  const listenButton = shadow.getElementById("listen");
  const active = captureState === "listening" || captureState === "recording";
  listenButton.querySelector("span").textContent = active ? "Stop recording" : "Start listening";
  listenButton.disabled = captureState === "stopping" || captureState === "generating";
  listenButton.classList.toggle("chosen", active);
  shadow.getElementById("generate").disabled = captureState !== "recorded";
  const modelSelect = shadow.getElementById("asr-model");
  if (modelSelect) {
    modelSelect.disabled = modelSwitching || ["listening", "recording", "stopping", "generating"].includes(captureState);
  }
}

function createOverlay() {
  if (overlayHost?.isConnected) return;
  overlayHost = document.createElement("div");
  overlayHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:50%;left:50%;transform:translate(-50%,-50%);isolation:isolate";
  const shadow = overlayHost.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box} .panel{width:min(330px,calc(100vw - 28px));padding:16px;background:#f3f5f0;color:#1d2c28;border:1px solid #d7dfd9;border-radius:8px;box-shadow:0 14px 40px #10231e36;font:13px/1.45 "Segoe UI Variable","Segoe UI",sans-serif}
      header{display:flex;align-items:center;gap:10px;margin-bottom:15px;cursor:grab;touch-action:none;user-select:none}header.dragging{cursor:grabbing}.brand{display:grid;width:34px;height:34px;place-items:center;border-radius:7px;background:#126e63;color:#fff;font:21px "Noto Sans Georgian",sans-serif}.heading{flex:1} .eyebrow{margin:0 0 2px;color:#687671;font-size:9px;font-weight:700;letter-spacing:1px} h2{margin:0;font-size:15px;font-weight:680}
      button{display:inline-flex;min-height:36px;align-items:center;justify-content:center;gap:7px;border:1px solid #d1dbd5;border-radius:5px;background:#fff;color:#263a34;font:inherit;font-weight:650;cursor:pointer;padding:0 10px}button:hover{border-color:#91aaa0;background:#f9fbf9}button:focus-visible{outline:2px solid #d29d3f;outline-offset:2px}
      select{width:100%;height:38px;padding:0 10px;border:1px solid #d1dbd5;border-radius:5px;background:#fff;color:#263a34;font:inherit}select:focus-visible{outline:2px solid #126e63;outline-offset:1px}select:disabled{opacity:.6}.model-status{min-height:14px;margin:4px 0 0;color:#687671;font-size:10px}
      .label{margin:12px 0 7px;color:#687671;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.row button{min-width:0}.chosen{border-color:#126e63!important;background:#e8f2ed!important;color:#0e5b52!important}.icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
      #status{min-height:34px;margin:10px 0 0;color:#586762;font-size:12px;line-height:1.45}.preview{display:none;width:100%;min-height:68px;max-height:140px;resize:vertical;overflow:auto;margin-top:9px;padding:10px;border:1px solid #e1e6e1;border-left:3px solid #d5a540;border-radius:4px;background:#fff;color:#20312b;font:13px/1.5 "Noto Sans Georgian",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}.preview:focus{outline:2px solid #126e63;outline-offset:1px}.preview:disabled{opacity:.65}
      .wide{width:100%;justify-content:flex-start}.primary{width:100%;margin-top:9px;border-color:#126e63;background:#126e63;color:#fff}.primary:hover{border-color:#0e5b52;background:#0e5b52}.primary:disabled,button:disabled{cursor:not-allowed;opacity:.5}.close{width:30px;min-height:30px;padding:0;color:#687671;font-size:17px}
    </style>
    <section class="panel" aria-label="Georgian audio typing">
      <header><span class="brand" aria-hidden="true">ა</span><div class="heading"><p class="eyebrow">GEORGIAN VOICE INPUT</p><h2>Audio to text</h2></div><button class="close" title="Close overlay" aria-label="Close">×</button></header>
      <p class="label">1 · Text destination</p>
      <button class="wide" id="choose" type="button"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM7 8h6M7 11h4M7 14h2"/></svg><span>Set text field</span></button>
      <p class="label">2 · Audio model</p>
      <select id="asr-model" aria-label="Speech recognition model" disabled><option>Loading models...</option></select>
      <p class="model-status" id="model-status" role="status">Connecting to local server...</p>
      <p class="label">3 · Chat audio</p>
      <div class="row"><button id="listen" type="button"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10l8-5z"/></svg><span>Listen to chat</span></button><button id="generate" type="button" disabled><span>Generate text</span></button></div>
      <p class="label">4 · Chat text</p>
      <button class="wide" id="use-page-text" type="button"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h10M5 8h10M5 12h7M5 16h10"/></svg><span>Read chat text</span></button>
      <p class="label">5 · Image text</p>
      <button class="wide" id="select-area" type="button"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7V4h3M13 4h3v3M16 13v3h-3M7 16H4v-3M7 10h6"/></svg><span>Extract screen text</span></button>
      <p id="status" role="status">Select the chat field, start listening, then play the voice message.</p>
      <textarea class="preview" id="preview" aria-label="Edit generated Georgian text" placeholder="Generated text can be edited here" disabled></textarea>
      <button class="primary" id="type" type="button" disabled>Type into chat</button>
    </section>`;
  document.documentElement.append(overlayHost);

  const status = shadow.getElementById("status");
  const preview = shadow.getElementById("preview");
  const typeButton = shadow.getElementById("type");
  const generateButton = shadow.getElementById("generate");
  const listenButton = shadow.getElementById("listen");
  const usePageTextButton = shadow.getElementById("use-page-text");
  const selectAreaButton = shadow.getElementById("select-area");
  const modelSelect = shadow.getElementById("asr-model");
  const modelStatus = shadow.getElementById("model-status");
  const dragHandle = shadow.querySelector("header");
  let selectedModelId = "";
  let pickingChatText = false;
  let highlightedTextElement = null;
  let previousTextOutline = "";

  function getChatTextElement(path) {
    const chatRootIndex = path.findIndex((item) => item instanceof HTMLElement && item.id === "chatPageWrapper");
    if (chatRootIndex < 0) return null;
    const chatPath = path.slice(0, chatRootIndex);
    const knownTextElement = chatPath.find((item) => item instanceof HTMLElement && item.matches(
      '#chatPageWrapper [class*="taskTextContent"], #chatPageWrapper [class*="correctText"], #chatPageWrapper [class*="taskText__"], #chatPageWrapper [class*="hintText"]'
    ));
    if (knownTextElement) return knownTextElement;

    return chatPath.find((item) => {
      if (!(item instanceof HTMLElement) || item.closest("button, a, input, textarea, select, [role='button']")) return false;
      const style = window.getComputedStyle(item);
      const text = item.innerText?.replace(/\s+/g, " ").trim();
      return Boolean(text && text.length <= 500 && style.display !== "none" && style.visibility !== "hidden" && item.getClientRects().length);
    }) || null;
  }

  function clearTextHighlight() {
    if (highlightedTextElement) highlightedTextElement.style.outline = previousTextOutline;
    highlightedTextElement = null;
    previousTextOutline = "";
  }

  function highlightChatText(event) {
    if (!pickingChatText) return;
    const nextElement = getChatTextElement(event.composedPath());
    if (nextElement === highlightedTextElement) return;
    clearTextHighlight();
    if (!nextElement) return;
    highlightedTextElement = nextElement;
    previousTextOutline = nextElement.style.outline;
    nextElement.style.outline = "2px solid #126e63";
  }

  function stopPickingChatText() {
    pickingChatText = false;
    overlayHost.style.pointerEvents = "";
    clearTextHighlight();
    document.removeEventListener("click", pickChatText, true);
    document.removeEventListener("pointermove", highlightChatText, true);
    document.removeEventListener("keydown", cancelChatTextPick, true);
  }

  function cancelChatTextPick(event) {
    if (event.key !== "Escape") return;
    stopPickingChatText();
    status.textContent = "Chat text selection cancelled.";
  }

  function pickChatText(event) {
    if (!pickingChatText) return;
    const path = event.composedPath();
    if (path.includes(overlayHost)) return;
    const isChatArea = path.some((item) => item instanceof Element && item.matches("#chatPageWrapper"));
    if (!isChatArea) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const textElement = getChatTextElement(path);
    const text = textElement?.innerText.replace(/\s+/g, " ").trim();
    if (!text) {
      status.textContent = "That item has no readable text. Click the chat text itself.";
      return;
    }

    stopPickingChatText();
    const lingwingField = getLingwingInputField();
    if (lingwingField) setSelectedField(lingwingField);
    preview.value = text;
    preview.disabled = false;
    preview.style.display = "block";
    typeButton.disabled = !isEditable(selectedField);
    typeButton.textContent = "Type into chat";
    status.textContent = lingwingField
      ? `Captured ${text.length} characters. Typing them into the Lingwing answer field...`
      : `Captured ${text.length} characters in the draft. Select a destination field to type it.`;
    if (lingwingField) typeButton.click();
  }

  function setSelectedField(field) {
    selectedField = field;
    shadow.getElementById("choose").classList.add("chosen");
    if (preview.value) {
      typeButton.disabled = false;
      typeButton.textContent = "Type into chat";
    }
  }

  modelSelect.addEventListener("change", async () => {
    const requestedModelId = modelSelect.value;
    if (!requestedModelId || requestedModelId === selectedModelId) return;
    modelSwitching = true;
    renderWorkflow();
    const requestedLabel = modelSelect.selectedOptions[0]?.textContent || requestedModelId;
    modelStatus.textContent = `Loading ${requestedLabel}. First-time loads may take a while...`;
    try {
      const result = await chrome.runtime.sendMessage({ type: "SELECT_ASR_MODEL", modelId: requestedModelId });
      if (result?.error) throw new Error(result.error);
      selectedModelId = result.selected_model;
      modelSelect.value = selectedModelId;
      modelStatus.textContent = `${result.label} · ${result.inference_mode}`;
    } catch (error) {
      modelSelect.value = selectedModelId;
      modelStatus.textContent = error.message || "Could not load the selected model.";
    } finally {
      modelSwitching = false;
      renderWorkflow();
    }
  });

  chrome.runtime.sendMessage({ type: "GET_ASR_MODELS" }).then((result) => {
    if (result?.error) throw new Error(result.error);
    modelSelect.replaceChildren(...result.models.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      return option;
    }));
    selectedModelId = result.selected_model;
    modelSelect.value = selectedModelId;
    modelStatus.textContent = result.ready ? "Loaded and ready" : "Model loading...";
    renderWorkflow();
  }).catch((error) => {
    modelSelect.disabled = true;
    modelStatus.textContent = error.message || "Could not connect to the model API.";
  });

  dragHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const bounds = overlayHost.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    overlayHost.style.left = `${bounds.left}px`;
    overlayHost.style.top = `${bounds.top}px`;
    overlayHost.style.transform = "none";
    dragHandle.classList.add("dragging");
    dragHandle.setPointerCapture(event.pointerId);

    const moveOverlay = (moveEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - bounds.width);
      const maxTop = Math.max(0, window.innerHeight - bounds.height);
      const left = Math.min(maxLeft, Math.max(0, moveEvent.clientX - offsetX));
      const top = Math.min(maxTop, Math.max(0, moveEvent.clientY - offsetY));
      overlayHost.style.left = `${left}px`;
      overlayHost.style.top = `${top}px`;
    };
    const stopDragging = () => {
      dragHandle.classList.remove("dragging");
      dragHandle.removeEventListener("pointermove", moveOverlay);
      dragHandle.removeEventListener("pointerup", stopDragging);
      dragHandle.removeEventListener("pointercancel", stopDragging);
    };

    dragHandle.addEventListener("pointermove", moveOverlay);
    dragHandle.addEventListener("pointerup", stopDragging, { once: true });
    dragHandle.addEventListener("pointercancel", stopDragging, { once: true });
    event.preventDefault();
  });

  shadow.querySelector(".close").addEventListener("click", () => overlayHost.remove());
  shadow.getElementById("choose").addEventListener("click", () => {
    if (isEditable(mostRecentlyFocusedField)) {
      setSelectedField(mostRecentlyFocusedField);
      status.textContent = "Text field selected. Start tab audio from the extension menu.";
    } else {
      choosingField = true;
      shadow.getElementById("choose").classList.remove("chosen");
      status.textContent = "Click an editable text field on the page.";
    }
  });

  usePageTextButton.addEventListener("click", () => {
    if (pickingChatText) {
      stopPickingChatText();
      status.textContent = "Chat text selection cancelled.";
      return;
    }
    pickingChatText = true;
    overlayHost.style.pointerEvents = "none";
    status.textContent = "Move over the chat text to highlight it, then click. Press Escape to cancel.";
    document.addEventListener("click", pickChatText, true);
    document.addEventListener("pointermove", highlightChatText, true);
    document.addEventListener("keydown", cancelChatTextPick, true);
  });

  selectAreaButton.addEventListener("click", () => {
    preview.value = "";
    preview.style.display = "none";
    preview.disabled = true;
    typeButton.disabled = true;
    typeButton.textContent = "Type into chat";
    status.textContent = "Drag over the screen text you want to extract.";
    overlayHost.style.display = "none";

    const selectionLayer = document.createElement("div");
    selectionLayer.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;cursor:crosshair;touch-action:none;background:rgba(18,110,99,.06)";
    const selectionBox = document.createElement("div");
    selectionBox.style.cssText = "position:fixed;display:none;border:2px solid #126e63;background:rgba(18,110,99,.16);pointer-events:none";
    selectionLayer.append(selectionBox);
    document.documentElement.append(selectionLayer);
    let startPoint;

    const updateBox = (event) => {
      const left = Math.min(startPoint.x, event.clientX);
      const top = Math.min(startPoint.y, event.clientY);
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${Math.abs(event.clientX - startPoint.x)}px`;
      selectionBox.style.height = `${Math.abs(event.clientY - startPoint.y)}px`;
    };
    const cancelSelection = () => {
      selectionLayer.remove();
      overlayHost.style.display = "block";
      status.textContent = "Area selection cancelled.";
      document.removeEventListener("keydown", onKeyDown, true);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") cancelSelection();
    };
    document.addEventListener("keydown", onKeyDown, true);

    selectionLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || startPoint) return;
      startPoint = { x: event.clientX, y: event.clientY };
      selectionBox.style.display = "block";
      updateBox(event);
      selectionLayer.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    selectionLayer.addEventListener("pointermove", (event) => {
      if (startPoint) updateBox(event);
    });
    selectionLayer.addEventListener("pointercancel", cancelSelection, { once: true });
    selectionLayer.addEventListener("pointerup", async (event) => {
      if (!startPoint) return;
      updateBox(event);
      const left = Math.min(startPoint.x, event.clientX);
      const top = Math.min(startPoint.y, event.clientY);
      const width = Math.abs(event.clientX - startPoint.x);
      const height = Math.abs(event.clientY - startPoint.y);
      selectionLayer.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      if (width < 8 || height < 8) {
        overlayHost.style.display = "block";
        status.textContent = "Select a larger area containing readable text.";
        return;
      }

      selectAreaButton.disabled = true;
      status.textContent = "Reading the selected area locally...";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "OCR_SCREEN_AREA",
          region: { x: left, y: top, width, height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        if (response?.error) throw new Error(response.error);
      } catch (error) {
        overlayHost.style.display = "block";
        selectAreaButton.disabled = false;
        status.textContent = error.message || "Could not extract text from the selected area.";
      }
    }, { once: true });
  });

  listenButton.addEventListener("click", async () => {
    const isListening = captureState === "listening" || captureState === "recording";
    if (!isListening && !isEditable(selectedField)) {
      status.textContent = "Set the chat text field before starting to listen.";
      return;
    }
    if (!isListening) {
      preview.value = "";
      preview.style.display = "none";
      preview.disabled = true;
      typeButton.disabled = true;
      typeButton.textContent = "Type into chat";
    }
    captureState = isListening ? "stopping" : "listening";
    renderWorkflow();
    status.textContent = isListening
      ? "Stopping recording and saving the audio clip..."
      : "Listening for tab audio. Play the message, then choose Stop recording when it ends.";
    try {
      const response = await chrome.runtime.sendMessage({ type: isListening ? "STOP_CAPTURE" : "START_CAPTURE" });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      captureState = "idle";
      renderWorkflow();
      status.textContent = error.message || "Could not control tab audio capture.";
    }
  });

  generateButton.addEventListener("click", async () => {
    if (captureState !== "recorded") return;
    captureState = "generating";
    renderWorkflow();
    status.textContent = "Generating Georgian transcription locally...";
    try {
      const response = await chrome.runtime.sendMessage({ type: "GENERATE_TRANSCRIPTION" });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      captureState = "idle";
      renderWorkflow();
      status.textContent = error.message || "Could not generate the transcription.";
    }
  });

  typeButton.addEventListener("click", async () => {
    const text = preview.value || "";
    if (!isEditable(selectedField) || !text.trim()) {
      status.textContent = "Select the chat text field and generate a transcription first.";
      return;
    }
    const field = selectedField;
    field.focus();
    const initialValue = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.value
      : null;
    const selectionStart = initialValue === null ? 0 : field.selectionStart ?? initialValue.length;
    const selectionEnd = initialValue === null ? 0 : field.selectionEnd ?? selectionStart;
    const prefix = initialValue === null ? "" : initialValue.slice(0, selectionStart);
    const suffix = initialValue === null ? "" : initialValue.slice(selectionEnd);
    const expectedValue = initialValue === null ? null : prefix + text + suffix;

    typeButton.disabled = true;
    typeButton.textContent = "Typing...";
    status.textContent = "Typing characters into the selected field...";
    try {
      const result = await chrome.runtime.sendMessage({ type: "TYPE_TEXT", text });
      if (result?.error) throw new Error(result.error);

      await new Promise((resolve) => setTimeout(resolve, 120));
      if (result?.complete && expectedValue !== null && field.value !== expectedValue) {
        const characters = Array.from(text);
        let accepted = 0;
        for (let count = 1; count <= characters.length; count += 1) {
          if (field.value === prefix + characters.slice(0, count).join("") + suffix) accepted = count;
          else break;
        }
        result.complete = false;
        result.typed = accepted;
      }

      typeButton.textContent = result?.complete ? "Typed into chat" : "Typing stopped";
      status.textContent = result?.complete
        ? "Georgian text entered one key at a time."
        : `The page accepted ${result?.typed || 0} of ${Array.from(text).length} characters. Check the field before retrying.`;
    } catch (error) {
      typeButton.textContent = "Typing stopped";
      status.textContent = error.message || "Could not type into this field.";
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!choosingField || event.composedPath().includes(overlayHost)) return;
    const field = event.composedPath().find(isEditable);
    if (!field) return;
    choosingField = false;
    setSelectedField(field);
    mostRecentlyFocusedField = field;
    status.textContent = "Text field selected. Start tab audio from the extension menu.";
    setTimeout(() => field.focus(), 0);
  }, true);

  chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATE" }).then((result) => {
    captureState = result?.state || "idle";
    renderWorkflow();
    if (captureState === "recorded") status.textContent = "Recorded chat audio is ready. Choose Generate text.";
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_OVERLAY") createOverlay();
  if (message.type === "SCREEN_CAPTURE_TAKEN" && overlayHost?.isConnected) {
    overlayHost.style.display = "block";
    overlayHost.shadowRoot.getElementById("status").textContent = "Screen captured. Extracting the selected text...";
  }
  if (message.type === "CAPTURE_STATE" && overlayHost?.isConnected) {
    captureState = message.state;
    renderWorkflow();
    const status = overlayHost.shadowRoot.getElementById("status");
    const messages = {
      listening: "Listening for tab audio. Play the message, then choose Stop recording when it ends.",
      recording: "Audio detected and recording. Choose Stop recording when the message ends.",
      stopping: "Stopping recording and saving the audio clip...",
      recorded: "Clip ready. Choose Generate text to transcribe it.",
      generating: "Generating Georgian text locally...",
    };
    if (messages[message.state]) status.textContent = messages[message.state];
  }
  if (message.type === "TRANSCRIPTION_RESULT") {
    createOverlay();
    const shadow = overlayHost.shadowRoot;
    const status = shadow.getElementById("status");
    const preview = shadow.getElementById("preview");
    const typeButton = shadow.getElementById("type");
    if (message.error) {
      captureState = message.retryable ? "recorded" : "idle";
      renderWorkflow();
      status.textContent = message.error;
      if (!message.retryable) {
        preview.value = "";
        preview.style.display = "none";
      }
      preview.disabled = true;
      typeButton.disabled = true;
      return;
    }
    preview.value = message.text;
    preview.disabled = false;
    preview.style.display = "block";
    captureState = "idle";
    renderWorkflow();
    typeButton.disabled = !message.text;
    typeButton.textContent = "Type into chat";
    status.textContent = message.text
      ? "Text generated. Review it, then choose Type into chat."
      : "No speech was detected.";
  }
  if (message.type === "SCREEN_OCR_RESULT") {
    createOverlay();
    overlayHost.style.display = "block";
    const shadow = overlayHost.shadowRoot;
    const status = shadow.getElementById("status");
    const preview = shadow.getElementById("preview");
    const typeButton = shadow.getElementById("type");
    const selectAreaButton = shadow.getElementById("select-area");
    selectAreaButton.disabled = false;
    if (message.error) {
      status.textContent = message.error;
      return;
    }
    preview.value = message.text || "";
    preview.disabled = false;
    preview.style.display = "block";
    typeButton.disabled = !preview.value || !isEditable(selectedField);
    typeButton.textContent = "Type into chat";
    status.textContent = message.text
      ? `Extracted ${message.text.length} characters. Review the text, then type it into chat.`
      : "No readable text was found in the selected area.";
  }
});
})();