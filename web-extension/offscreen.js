const API_URL = "http://127.0.0.1:8000/transcribe";
const OCR_URL = "http://127.0.0.1:8000/screen-ocr";
const RMS_THRESHOLD = 0.012;
const MAX_RECORDING_MS = 180_000;
const RECORDING_DB_NAME = "georgian-audio-typing";
const RECORDING_STORE_NAME = "clips";
const RECORDING_KEY = "pending";
let mediaRecorder;
let capturedStream;
let audioContext;
let analyser;
let activeTabId;
let chunks = [];
let pendingRecording;
let activityTimer;
let captureStartedAt = 0;
let consecutiveLoudFrames = 0;
let detectedAudio = false;
let stopRequested = false;
let finishing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  if (message.type === "START_CAPTURE") startCapture(message.streamId, message.tabId);
  if (message.type === "STOP_CAPTURE") finishRecording();
  if (message.type === "GENERATE_TRANSCRIPTION") {
    if (message.tabId != null) activeTabId = message.tabId;
    loadPendingRecording().then((storedRecording) => {
      pendingRecording ||= storedRecording;
      if (pendingRecording) {
        sendResponse({ ok: true });
        console.info("[Georgian Audio] Generating transcript from recorded clip", pendingRecording.size, "bytes");
        generateTranscription().catch((error) => {
          console.error("[Georgian Audio] Unexpected transcription error:", error);
          notifyResult("", error.message || "Unexpected transcription error.", true);
        });
        return;
      }
      console.warn("[Georgian Audio] No recorded clip is available for transcription");
      sendResponse({ error: "No recorded clip is available. Listen to the chat audio again." });
    }).catch((error) => {
      console.error("[Georgian Audio] Could not restore the recorded clip:", error);
      sendResponse({ error: "Could not restore the recorded clip. Listen to the chat audio again." });
    });
    return true;
  }
  if (message.type === "OCR_SCREEN_IMAGE") {
    activeTabId = message.tabId;
    sendResponse({ ok: true });
    processScreenOcr(message).catch((error) => {
      console.error("[Georgian Audio] Screen OCR failed:", error);
      notifyScreenOcr("", error.message || "Could not extract text from the selected area.");
    });
    return false;
  }
});

async function cropScreenshot(screenshot, region, viewport) {
  if (!screenshot.startsWith("data:image/png;base64,")) {
    throw new Error("Chrome did not return a PNG screenshot for the selected area.");
  }
  const binary = atob(screenshot.slice(screenshot.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const left = Math.max(0, Math.min(bitmap.width, Math.floor(region.x * scaleX)));
  const top = Math.max(0, Math.min(bitmap.height, Math.floor(region.y * scaleY)));
  const right = Math.max(left, Math.min(bitmap.width, Math.ceil((region.x + region.width) * scaleX)));
  const bottom = Math.max(top, Math.min(bitmap.height, Math.ceil((region.y + region.height) * scaleY)));
  if (right - left < 2 || bottom - top < 2) {
    bitmap.close();
    throw new Error("Selected screen area is too small.");
  }

  const canvas = new OffscreenCanvas(right - left, bottom - top);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function processScreenOcr(message) {
  console.info("[Georgian Audio] Cropping selected area from captured screen", message.region);
  const crop = await cropScreenshot(message.screenshot, message.region, message.viewport);
  const form = new FormData();
  form.append("image", crop, "selected-screen-area.png");
  console.info("[Georgian Audio] Sending selected screen crop for local OCR", crop.size, "bytes");
  const response = await fetch(OCR_URL, { method: "POST", body: form });
  const result = await response.json();
  console.info("[Georgian Audio] OCR endpoint responded", response.status);
  if (!response.ok) throw new Error(result.detail || "The local OCR service returned an error.");
  await notifyScreenOcr(result.text || "", "");
}

async function notifyScreenOcr(text, error) {
  await chrome.runtime.sendMessage({
    type: "SCREEN_OCR_RESULT",
    tabId: activeTabId,
    text,
    error,
  });
}

async function startCapture(streamId, tabId) {
  activeTabId = tabId;
  chunks = [];
  pendingRecording = undefined;
  detectedAudio = false;
  stopRequested = false;
  finishing = false;
  consecutiveLoudFrames = 0;
  try {
    await clearPendingRecording();
    capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    audioContext = new AudioContext();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioContext.createMediaStreamSource(capturedStream);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    mediaRecorder = new MediaRecorder(capturedStream, { mimeType });
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", storeRecording, { once: true });
    mediaRecorder.start(500);
    captureStartedAt = Date.now();
    activityTimer = setInterval(checkAudioActivity, 100);
    notifyActivity("listening");
    if (stopRequested) finishRecording();
  } catch (error) {
    await cleanupCapture();
    await notifyResult("", error.message || "Could not access captured tab audio.");
  }
}

function checkAudioActivity() {
  if (!analyser || mediaRecorder?.state !== "recording" || finishing) return;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const now = Date.now();

  if (rms >= RMS_THRESHOLD) {
    consecutiveLoudFrames += 1;
    if (!detectedAudio && consecutiveLoudFrames >= 2) {
      detectedAudio = true;
      notifyActivity("recording");
    }
  } else {
    consecutiveLoudFrames = 0;
  }

  if (now - captureStartedAt >= MAX_RECORDING_MS) {
    finishRecording();
  }
}

function finishRecording() {
  if (!mediaRecorder) {
    stopRequested = true;
    return;
  }
  if (mediaRecorder.state !== "recording" || finishing) return;
  finishing = true;
  clearInterval(activityTimer);
  notifyActivity("stopping");
  mediaRecorder.stop();
}

async function storeRecording() {
  const hadAudio = detectedAudio;
  const recording = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
  chunks = [];
  await cleanupCapture();

  if (!hadAudio || !recording.size) {
    await notifyResult("", "No audio detected. Start listening before playing the chat voice message.");
    return;
  }

  pendingRecording = recording;
  try {
    await savePendingRecording(recording);
  } catch (error) {
    pendingRecording = undefined;
    console.error("[Georgian Audio] Could not persist recorded clip:", error);
    await notifyResult("", error.message || "Could not save the recorded audio clip.");
    return;
  }
  notifyActivity("recorded");
}

async function generateTranscription() {
  pendingRecording ||= await loadPendingRecording();
  if (!pendingRecording) {
    await notifyResult("", "No recorded clip is ready. Start listening and play the voice message first.");
    return;
  }

  const recording = pendingRecording;
  pendingRecording = undefined;
  try {
    const form = new FormData();
    form.append("audio", recording, "tab-recording.webm");
    console.info("[Georgian Audio] Posting recorded clip to local transcription API", recording.size, "bytes");
    const response = await fetch(API_URL, { method: "POST", body: form });
    const result = await response.json();
    console.info("[Georgian Audio] Local transcription API responded", response.status);
    if (!response.ok) throw new Error(result.detail || "The local transcription server returned an error.");
    await clearPendingRecording();
    pendingRecording = undefined;
    await notifyResult(result.text || "", "");
  } catch (error) {
    await notifyResult("", error.message || "Could not reach the local transcription server.", true);
  }
}

function openRecordingDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDING_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(RECORDING_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePendingRecording(recording) {
  const database = await openRecordingDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDING_STORE_NAME, "readwrite");
    transaction.objectStore(RECORDING_STORE_NAME).put(recording, RECORDING_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function loadPendingRecording() {
  const database = await openRecordingDatabase();
  const recording = await new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDING_STORE_NAME, "readonly");
    const request = transaction.objectStore(RECORDING_STORE_NAME).get(RECORDING_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return recording;
}

async function clearPendingRecording() {
  const database = await openRecordingDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDING_STORE_NAME, "readwrite");
    transaction.objectStore(RECORDING_STORE_NAME).delete(RECORDING_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function cleanupCapture() {
  clearInterval(activityTimer);
  activityTimer = undefined;
  capturedStream?.getTracks().forEach((track) => track.stop());
  capturedStream = undefined;
  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  audioContext = undefined;
  analyser = undefined;
  mediaRecorder = undefined;
}

function notifyActivity(state) {
  chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVITY", state, tabId: activeTabId }).catch(() => {});
}

async function notifyResult(text, error, retryable = false) {
  await chrome.runtime.sendMessage({
    type: "TRANSCRIPTION_RESULT",
    tabId: activeTabId,
    text,
    error,
    retryable,
  });
}