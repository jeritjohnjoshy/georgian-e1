const statusText = document.getElementById("status");
const overlayButton = document.getElementById("overlay");
const connectionPanel = document.getElementById("connection");
const connectionDetail = document.getElementById("server-detail");
const connectionButton = document.getElementById("server-check");
const HEALTH_URL = "http://127.0.0.1:8000/health";

connectionButton.addEventListener("click", async () => {
  connectionButton.disabled = true;
  connectionPanel.dataset.state = "checking";
  connectionDetail.textContent = "Checking 127.0.0.1:8000...";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(HEALTH_URL, { cache: "no-store", signal: controller.signal });
    const health = await response.json();
    if (!response.ok) throw new Error("The server returned an error.");
    if (health.status !== "ready") {
      connectionPanel.dataset.state = "loading";
      connectionDetail.textContent = `API online · model ${health.status || "starting"}`;
    } else {
      connectionPanel.dataset.state = "ready";
      connectionDetail.textContent = `${health.model || "ASR model ready"} · ${health.device || "local"}`;
    }
  } catch (error) {
    connectionPanel.dataset.state = "offline";
    connectionDetail.textContent = controller.signal.aborted
      ? "No response · server may still be loading"
      : "Offline · start the local server first";
  } finally {
    clearTimeout(timeoutId);
    connectionButton.disabled = false;
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open a normal website tab first.");
  return tab;
}

async function openOverlay(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  await chrome.tabs.sendMessage(tab.id, { type: "SHOW_OVERLAY" });
}

overlayButton.addEventListener("click", async () => {
  try {
    await openOverlay(await getActiveTab());
    statusText.textContent = "Overlay is open. Choose the text field on the page.";
  } catch (error) {
    statusText.textContent = error.message || "Could not open the overlay on this page.";
  }
});
