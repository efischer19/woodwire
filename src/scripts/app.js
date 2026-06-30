/**
 * Woodwire PWA — Main Script
 *
 * Handles theme persistence, connection setup, offline queueing, service worker
 * registration, message sending, and polling for bot responses.
 */

"use strict";

const STORAGE_KEYS = {
  apiBase: "woodwire_api_base",
  auth: "woodwire_auth",
  queue: "woodwire_queue",
};
const POLL_INTERVAL_MS = 3000;

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initChatApp();
});

function initChatApp() {
  const elements = getAppElements();
  if (!elements.composer || !elements.messageHistory || !elements.setupForm) {
    return;
  }

  const state = {
    activePollers: new Map(),
    isDrainingQueue: false,
  };

  hydrateSetupForm(elements);
  renderQueuedMessages(elements);
  updateConnectivity(elements);
  updateQueueStatus(elements);
  updateConnectionUi(elements);
  registerServiceWorker();

  elements.setupForm.addEventListener("submit", (event) => {
    event.preventDefault();

    try {
      const apiBaseUrl = normalizeApiBaseUrl(elements.workerUrl.value);
      const passphrase = elements.passphrase.value.trim();

      if (!passphrase) {
        showFlashMessage(elements, "Enter a passphrase before continuing.", true);
        elements.passphrase.focus();
        return;
      }

      setStorageItem(STORAGE_KEYS.apiBase, apiBaseUrl);
      setStorageItem(STORAGE_KEYS.auth, passphrase);
      toggleSetupPanel(elements, false);
      updateConnectionUi(elements);
      updateQueueStatus(elements);
      showFlashMessage(elements, "Connection details saved on this device.");
      elements.messageInput.focus();

      if (navigator.onLine) {
        void drainQueue(elements, state);
      }
    } catch (error) {
      showFlashMessage(elements, error.message, true);
    }
  });

  elements.connectionSettings.addEventListener("click", () => {
    toggleSetupPanel(elements, elements.setupPanel.classList.contains("is-hidden"));
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const text = elements.messageInput.value.trim();
      if (!text) {
        return;
      }

      if (!getStorageItem(STORAGE_KEYS.auth)) {
        toggleSetupPanel(elements, true);
        showFlashMessage(elements, "Save your passphrase before sending a message.", true);
        elements.passphrase.focus();
        return;
      }

      const localMessage = createLocalMessage(text);
      appendMessage(elements, {
        author: "You",
        localId: localMessage.localId,
        status: navigator.onLine ? "Sending…" : "Queued for delivery",
        text: localMessage.text,
        timestamp: localMessage.createdAt,
        variant: "user",
      });

      elements.messageInput.value = "";

      if (!navigator.onLine) {
        enqueueMessage(localMessage);
        updateQueueStatus(elements);
        announce(elements, "Message queued until you are back online.");
        return;
      }

      const sendState = await sendMessage(localMessage, elements, state);
      if (sendState === "queued") {
        enqueueMessage(localMessage);
        updateQueueStatus(elements);
      }
    } catch {
      showFlashMessage(elements, "The message could not be prepared for sending.", true);
    }
  });

  window.addEventListener("online", () => {
    updateConnectivity(elements);
    showFlashMessage(elements, "Back online. Sending queued messages.");
    void drainQueue(elements, state).catch(() => {
      showFlashMessage(elements, "Queued messages could not be resent.", true);
    });
  });

  window.addEventListener("offline", () => {
    updateConnectivity(elements);
    updateQueueStatus(elements);
    announce(elements, "You are offline. Messages will be queued.");
  });

  if (navigator.onLine) {
    void drainQueue(elements, state).catch(() => {
      showFlashMessage(elements, "Queued messages could not be resent.", true);
    });
  }
}

function getAppElements() {
  return {
    composer: document.getElementById("composer"),
    connectionSettings: document.getElementById("connection-settings"),
    flashMessage: document.getElementById("flash-message"),
    messageHistory: document.getElementById("message-history"),
    messageInput: document.getElementById("message-input"),
    offlineIndicator: document.getElementById("offline-indicator"),
    passphrase: document.getElementById("passphrase"),
    queueStatus: document.getElementById("queue-status"),
    screenReaderStatus: document.getElementById("screen-reader-status"),
    setupForm: document.getElementById("setup-form"),
    setupPanel: document.getElementById("setup-panel"),
    workerUrl: document.getElementById("worker-url"),
  };
}

function hydrateSetupForm(elements) {
  elements.workerUrl.value = getStorageItem(STORAGE_KEYS.apiBase) || "";
  elements.passphrase.value = getStorageItem(STORAGE_KEYS.auth) || "";
  toggleSetupPanel(elements, !getStorageItem(STORAGE_KEYS.auth));
}

function updateConnectionUi(elements) {
  const hasAuth = Boolean(getStorageItem(STORAGE_KEYS.auth));
  elements.messageInput.disabled = !hasAuth;
  elements.composer.querySelector("button[type='submit']").disabled = !hasAuth;
  elements.connectionSettings.textContent = hasAuth
    ? "Update connection"
    : "Connection settings";
}

function toggleSetupPanel(elements, shouldShow) {
  elements.setupPanel.classList.toggle("is-hidden", !shouldShow);
  elements.connectionSettings.setAttribute("aria-expanded", String(shouldShow));
}

function updateConnectivity(elements) {
  elements.offlineIndicator.classList.toggle("is-hidden", navigator.onLine);
}

function showFlashMessage(elements, message, isError = false) {
  elements.flashMessage.textContent = message;
  elements.flashMessage.classList.remove("is-hidden");
  elements.flashMessage.classList.toggle("is-error", isError);
  announce(elements, message);
}

function announce(elements, message) {
  elements.screenReaderStatus.textContent = message;
}

function createLocalMessage(text) {
  return {
    createdAt: new Date().toISOString(),
    localId:
      globalThis.crypto?.randomUUID?.() ||
      `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
  };
}

async function sendMessage(message, elements, state) {
  try {
    const response = await workerFetch("/api/message", {
      body: JSON.stringify({
        attachments: [],
        text: message.text,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await getErrorMessage(response));
    }

    const payload = await response.json();
    updateMessageStatus(elements, message.localId, "Sent · waiting for reply", false);
    startConversationPolling(payload.conversationId, message.localId, elements, state);
    announce(elements, "Message sent. Waiting for a reply.");
    return "sent";
  } catch (error) {
    if (isNetworkFailure(error)) {
      updateMessageStatus(elements, message.localId, "Queued for delivery", false);
      return "queued";
    }

    updateMessageStatus(elements, message.localId, error.message, true);
    showFlashMessage(elements, error.message, true);
    return "error";
  }
}

function startConversationPolling(conversationId, localId, elements, state) {
  if (state.activePollers.has(conversationId)) {
    return;
  }

  const poll = async () => {
    try {
      const response = await workerFetch(`/api/status/${conversationId}`, {
        method: "GET",
      });
      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      const payload = await response.json();
      const statusLabel =
        payload.status === "complete"
          ? "Reply ready"
          : payload.status === "processing"
            ? "Bot is replying…"
            : "Waiting for the bot…";

      updateMessageStatus(elements, localId, statusLabel, false);

      if (payload.status === "complete") {
        stopConversationPolling(conversationId, state);
        await appendAssistantReply(conversationId, elements);
      }
    } catch (error) {
      if (!isNetworkFailure(error)) {
        stopConversationPolling(conversationId, state);
        updateMessageStatus(elements, localId, error.message, true);
      }
    }
  };

  poll();
  const timer = window.setInterval(poll, POLL_INTERVAL_MS);
  state.activePollers.set(conversationId, timer);
}

function stopConversationPolling(conversationId, state) {
  const timer = state.activePollers.get(conversationId);
  if (timer) {
    window.clearInterval(timer);
    state.activePollers.delete(conversationId);
  }
}

async function appendAssistantReply(conversationId, elements) {
  if (elements.messageHistory.querySelector(`[data-response-for="${conversationId}"]`)) {
    return;
  }

  const response = await workerFetch(`/api/response/${conversationId}`, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  const download = await fetch(payload.downloadUrl);
  if (!download.ok) {
    throw new Error("The reply is ready, but the response download failed.");
  }

  const replyText = await download.text();
  appendMessage(elements, {
    author: "AI",
    responseFor: conversationId,
    text: replyText || "The bot returned an empty reply.",
    timestamp: new Date().toISOString(),
    variant: "assistant",
  });
  announce(elements, "AI reply received.");
}

async function drainQueue(elements, state) {
  if (state.isDrainingQueue || !navigator.onLine) {
    return;
  }

  const queue = getQueuedMessages();
  if (!queue.length) {
    updateQueueStatus(elements);
    return;
  }

  state.isDrainingQueue = true;

  for (const message of queue) {
    const sendState = await sendMessage(message, elements, state);
    if (sendState !== "sent") {
      break;
    }

    if (elements.messageHistory.querySelector(`[data-local-id="${message.localId}"]`)) {
      removeQueuedMessage(message.localId);
      updateQueueStatus(elements);
      continue;
    }
  }

  state.isDrainingQueue = false;
  updateQueueStatus(elements);
}

function renderQueuedMessages(elements) {
  const queuedMessages = getQueuedMessages();
  for (const message of queuedMessages) {
    if (elements.messageHistory.querySelector(`[data-local-id="${message.localId}"]`)) {
      continue;
    }

    appendMessage(elements, {
      author: "You",
      localId: message.localId,
      status: "Queued for delivery",
      text: message.text,
      timestamp: message.createdAt,
      variant: "user",
    });
  }
}

function appendMessage(elements, message) {
  const article = document.createElement("article");
  article.className = `message message-${message.variant}`;

  if (message.localId) {
    article.dataset.localId = message.localId;
  }

  if (message.responseFor) {
    article.dataset.responseFor = message.responseFor;
  }

  const body = document.createElement("div");
  body.className = "message-body";

  const text = document.createElement("p");
  text.textContent = message.text;
  body.append(text);

  if (message.status) {
    const status = document.createElement("p");
    status.className = "message-status";
    status.textContent = message.status;
    body.append(status);
  }

  const meta = document.createElement("p");
  meta.className = "message-meta";
  meta.append(document.createTextNode(message.author));

  const time = document.createElement("time");
  time.dateTime = message.timestamp;
  time.textContent = formatTimestamp(message.timestamp);
  meta.append(time);

  article.append(body, meta);
  elements.messageHistory.append(article);
  elements.messageHistory.scrollTop = elements.messageHistory.scrollHeight;
}

function updateMessageStatus(elements, localId, statusText, isError) {
  const message = elements.messageHistory.querySelector(`[data-local-id="${localId}"]`);
  if (!message) {
    return;
  }

  const status = message.querySelector(".message-status");
  if (!status) {
    return;
  }

  status.textContent = statusText;
  status.classList.toggle("is-error", isError);
}

function updateQueueStatus(elements) {
  const count = getQueuedMessages().length;
  const hasAuth = Boolean(getStorageItem(STORAGE_KEYS.auth));

  if (!hasAuth) {
    elements.queueStatus.textContent = "Save your passphrase to start sending messages.";
    return;
  }

  if (!navigator.onLine) {
    elements.queueStatus.textContent =
      count > 0
        ? `${count} queued message${count === 1 ? "" : "s"} waiting for reconnect.`
        : "Offline. New messages will be queued.";
    return;
  }

  if (count > 0) {
    elements.queueStatus.textContent = `${count} queued message${count === 1 ? "" : "s"} waiting to send.`;
    return;
  }

  elements.queueStatus.textContent = "Ready to send.";
}

function enqueueMessage(message) {
  const queue = getQueuedMessages();
  queue.push(message);
  setQueuedMessages(queue);
}

function removeQueuedMessage(localId) {
  const queue = getQueuedMessages().filter((message) => message.localId !== localId);
  setQueuedMessages(queue);
}

function getQueuedMessages() {
  return getStorageJson(STORAGE_KEYS.queue, []);
}

function setQueuedMessages(queue) {
  setStorageItem(STORAGE_KEYS.queue, JSON.stringify(queue));
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return window.location.origin;
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Worker URL must start with http:// or https://.");
  }

  return url.origin;
}

async function workerFetch(pathname, options) {
  const auth = getStorageItem(STORAGE_KEYS.auth);
  const apiBase = getStorageItem(STORAGE_KEYS.apiBase) || window.location.origin;
  const url = new URL(pathname, `${apiBase}/`);
  const headers = new Headers(options?.headers || {});

  if (auth) {
    headers.set("X-Woodwire-Auth", auth);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

async function getErrorMessage(response) {
  try {
    const payload = await response.json();
    if (payload?.error) {
      return payload.error;
    }
  } catch {
    return `Request failed with status ${response.status}.`;
  }

  return `Request failed with status ${response.status}.`;
}

function isNetworkFailure(error) {
  return error instanceof TypeError;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getStorageItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorageItem(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    throw new Error("Local storage is unavailable in this browser.");
  }
}

function getStorageJson(key, fallbackValue) {
  const rawValue = getStorageItem(key);
  if (!rawValue) {
    return fallbackValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return fallbackValue;
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
    return;
  }

  window.addEventListener("load", () => {
    const serviceWorkerUrl = new URL("sw.js", window.location.href).toString();
    navigator.serviceWorker.register(serviceWorkerUrl).catch(() => {
      // Ignore registration failures in unsupported local environments.
    });
  });
}

/**
 * Initialize the dark/light theme toggle.
 */
function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const saved = localStorage.getItem("theme");
  const initial = saved || (prefersDark.matches ? "dark" : "light");
  applyTheme(initial, toggle);

  toggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next, toggle);
    localStorage.setItem("theme", next);
  });

  prefersDark.addEventListener("change", (event) => {
    if (!localStorage.getItem("theme")) {
      applyTheme(event.matches ? "dark" : "light", toggle);
    }
  });
}

/**
 * Apply a theme and update the toggle button state.
 *
 * @param {"light" | "dark"} theme - The theme to apply.
 * @param {HTMLElement} toggle - The toggle button element.
 */
function applyTheme(theme, toggle) {
  document.documentElement.setAttribute("data-theme", theme);
  const isDark = theme === "dark";
  toggle.setAttribute("aria-pressed", String(isDark));
  toggle.querySelector(".icon").textContent = isDark ? "☀️" : "🌙";
  toggle.querySelector(".label").textContent = isDark
    ? "Light mode"
    : "Dark mode";
}
