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
  history: "woodwire_history",
  pendingConversations: "woodwire_pending_conversations",
  queue: "woodwire_queue",
};
const WORKER_BASE_URL = window.location.origin;
const WORKER_BASE_ORIGIN = new URL(WORKER_BASE_URL).origin;
const MAX_STORED_MESSAGES = 200;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const SERVICE_WORKER_PATH = "sw.js";
let fallbackMessageCounter = 0;

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
    isDrainingQueue: false,
    pendingConversations: new Map(
      getPendingConversations().map((conversation) => [conversation.conversationId, conversation]),
    ),
    pollTimer: 0,
    queueRetryTimer: 0,
  };

  hydrateSetupForm(elements);
  renderStoredMessages(elements);
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
        ensurePollingLoop(elements, state);
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
    ensurePollingLoop(elements, state);
    void drainQueue(elements, state).catch(() => {
      showFlashMessage(elements, "Queued messages could not be resent.", true);
    });
  });

  window.addEventListener("offline", () => {
    stopPollingLoop(state);
    updateConnectivity(elements);
    updateQueueStatus(elements);
    announce(elements, "You are offline. Messages will be queued.");
  });

  if (navigator.onLine) {
    ensurePollingLoop(elements, state);
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
    sendButton: document.getElementById("send-button"),
    setupForm: document.getElementById("setup-form"),
    setupPanel: document.getElementById("setup-panel"),
    workerUrl: document.getElementById("worker-url"),
  };
}

function hydrateSetupForm(elements) {
  elements.workerUrl.value = getStorageItem(STORAGE_KEYS.apiBase) || WORKER_BASE_URL;
  elements.passphrase.value = getStorageItem(STORAGE_KEYS.auth) || "";
  toggleSetupPanel(elements, !getStorageItem(STORAGE_KEYS.auth));
}

function updateConnectionUi(elements) {
  const hasAuth = Boolean(getStorageItem(STORAGE_KEYS.auth));
  elements.messageInput.disabled = !hasAuth;
  elements.sendButton.disabled = !hasAuth;
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
  fallbackMessageCounter += 1;

  return {
    createdAt: new Date().toISOString(),
    localId:
      globalThis.crypto?.randomUUID?.() ||
      `local-${Date.now()}-${fallbackMessageCounter}`,
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
      throw await createResponseError(response);
    }

    const payload = await response.json();
    updateMessageStatus(elements, message.localId, "Sent · waiting for reply", false);
    trackPendingConversation(state, {
      conversationId: payload.conversationId,
      localId: message.localId,
      startedAt: Date.now(),
    });
    ensurePollingLoop(elements, state);
    announce(elements, "Message sent. Waiting for a reply.");
    return "sent";
  } catch (error) {
    if (isNetworkFailure(error)) {
      showFlashMessage(
        elements,
        "Connection lost. Message will be sent when you're back online.",
        true,
      );
      updateMessageStatus(elements, message.localId, "Queued for delivery", false);
      return "queued";
    }

    if (error.status === 401) {
      handleAuthenticationFailure(elements, state, message.localId);
      return "error";
    }

    if (error.status === 429) {
      scheduleQueueDrain(elements, state, getBackoffDelay(error));
      updateMessageStatus(elements, message.localId, "Queued for retry", false);
      showFlashMessage(elements, error.message, true);
      return "queued";
    }

    updateMessageStatus(elements, message.localId, error.message, true);
    showFlashMessage(elements, error.message, true);
    return "error";
  }
}

function trackPendingConversation(state, conversation) {
  state.pendingConversations.set(conversation.conversationId, conversation);
  syncPendingConversations(state);
}

function clearPendingConversation(conversationId, state) {
  state.pendingConversations.delete(conversationId);
  syncPendingConversations(state);
}

function ensurePollingLoop(elements, state, delayMs = 0) {
  if (
    state.pollTimer ||
    !navigator.onLine ||
    !state.pendingConversations.size ||
    !getStorageItem(STORAGE_KEYS.auth)
  ) {
    return;
  }

  state.pollTimer = window.setTimeout(async () => {
    state.pollTimer = 0;
    await runPollingCycle(elements, state);
  }, delayMs);
}

async function runPollingCycle(elements, state) {
  if (!state.pendingConversations.size) {
    return;
  }

  let nextDelayMs = POLL_INTERVAL_MS;

  for (const conversation of state.pendingConversations.values()) {
    const result = await pollConversation(conversation, elements, state);

    if (result?.stopLoop) {
      return;
    }

    if (result?.nextDelayMs) {
      nextDelayMs = Math.max(nextDelayMs, result.nextDelayMs);
    }
  }

  if (state.pendingConversations.size) {
    ensurePollingLoop(elements, state, nextDelayMs);
  }
}

function stopPollingLoop(state) {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
}

async function pollConversation(conversation, elements, state) {
  if (Date.now() - conversation.startedAt >= POLL_TIMEOUT_MS) {
    clearPendingConversation(conversation.conversationId, state);
    updateMessageStatus(
      elements,
      conversation.localId,
      "The AI is taking longer than expected. Your message was received and will be processed.",
      false,
    );
    showFlashMessage(
      elements,
      "The AI is taking longer than expected. Your message was received and will be processed.",
      true,
    );
    return { nextDelayMs: POLL_INTERVAL_MS };
  }

  try {
    const response = await workerFetch(`/api/status/${conversation.conversationId}`, {
      method: "GET",
    });
    if (!response.ok) {
      throw await createResponseError(response);
    }

    const payload = await response.json();
    const statusLabel =
      payload.status === "complete"
        ? "Reply ready"
        : payload.status === "processing"
          ? "Bot is replying…"
          : "Waiting for the bot…";

    updateMessageStatus(elements, conversation.localId, statusLabel, false);

    if (payload.status === "complete") {
      await appendAssistantReply(conversation, elements);
      clearPendingConversation(conversation.conversationId, state);
      updateMessageStatus(elements, conversation.localId, "Reply received", false);
    }

    return {
      nextDelayMs: normalizePollDelay(payload.cacheTtlSeconds),
    };
  } catch (error) {
    if (isNetworkFailure(error)) {
      updateMessageStatus(elements, conversation.localId, "Waiting to reconnect…", false);
      showFlashMessage(
        elements,
        "Connection lost. Message will be sent when you're back online.",
        true,
      );

      if (!navigator.onLine) {
        stopPollingLoop(state);
      }

      return { nextDelayMs: POLL_INTERVAL_MS };
    }

    if (error.status === 401) {
      updateMessageStatus(elements, conversation.localId, error.message, true);
      handleAuthenticationFailure(elements, state);
      return { stopLoop: true };
    }

    if (error.status === 429) {
      updateMessageStatus(elements, conversation.localId, "Waiting to retry…", false);
      showFlashMessage(elements, error.message, true);
      return { nextDelayMs: getBackoffDelay(error) };
    }

    clearPendingConversation(conversation.conversationId, state);
    updateMessageStatus(elements, conversation.localId, error.message, true);
    showFlashMessage(elements, error.message, true);
    return { nextDelayMs: POLL_INTERVAL_MS };
  }
}

async function appendAssistantReply(conversation, elements) {
  if (
    elements.messageHistory.querySelector(
      `[data-response-for="${conversation.conversationId}"]`,
    )
  ) {
    return;
  }

  const response = await workerFetch(`/api/response/${conversation.conversationId}`, {
    method: "GET",
  });
  if (!response.ok) {
    throw await createResponseError(response);
  }

  const payload = await response.json();
  const download = await fetch(payload.downloadUrl);
  if (!download.ok) {
    throw new Error("The reply is ready, but the response download failed.");
  }

  const replyText = await download.text();
  appendMessage(elements, {
    author: "AI",
    conversationId: conversation.conversationId,
    responseFor: conversation.conversationId,
    text: replyText || "The bot returned an empty reply.",
    timestamp: new Date().toISOString(),
    variant: "assistant",
  });
  announce(elements, "AI reply received.");
}

async function drainQueue(elements, state) {
  if (state.isDrainingQueue || !navigator.onLine) {
    return "skipped";
  }

  const queue = getQueuedMessages();
  if (!queue.length) {
    updateQueueStatus(elements);
    return "empty";
  }

  state.isDrainingQueue = true;

  for (const message of queue) {
    const sendState = await sendMessage(message, elements, state);
    if (sendState !== "sent") {
      state.isDrainingQueue = false;
      updateQueueStatus(elements);
      return sendState;
    }

    if (elements.messageHistory.querySelector(`[data-local-id="${message.localId}"]`)) {
      removeQueuedMessage(message.localId);
      updateQueueStatus(elements);
      continue;
    }
  }

  state.isDrainingQueue = false;
  updateQueueStatus(elements);
  return "sent";
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

function renderStoredMessages(elements) {
  const history = getStoredMessages();

  if (!history.length) {
    return;
  }

  elements.messageHistory.innerHTML = "";

  for (const message of history) {
    appendMessage(
      elements,
      {
        author: message.role === "ai" ? "AI" : "You",
        conversationId: message.conversationId,
        localId: message.role === "user" ? message.id : undefined,
        responseFor: message.role === "ai" ? message.conversationId || message.id : undefined,
        status: message.role === "user" ? message.status || undefined : undefined,
        text: message.text,
        timestamp: message.timestamp,
        variant: message.role === "ai" ? "assistant" : "user",
      },
      { persist: false },
    );
  }
}

function appendMessage(elements, message, options = {}) {
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

  if (options.persist !== false) {
    upsertStoredMessage(message);
  }
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
  updateStoredMessageStatus(localId, statusText);
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

function getStoredMessages() {
  return getStorageJson(STORAGE_KEYS.history, []);
}

function setStoredMessages(messages) {
  setStorageItem(
    STORAGE_KEYS.history,
    JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)),
  );
}

function upsertStoredMessage(message) {
  const storedMessage = {
    conversationId: message.conversationId || message.responseFor || null,
    id: message.variant === "assistant" ? message.responseFor : message.localId,
    role: message.variant === "assistant" ? "ai" : "user",
    status: message.status || null,
    text: message.text,
    timestamp: message.timestamp,
  };
  const messages = getStoredMessages().filter((item) =>
    isDifferentStoredMessage(item, storedMessage),
  );

  messages.push(storedMessage);
  setStoredMessages(messages);
}

function updateStoredMessageStatus(localId, statusText) {
  const messages = getStoredMessages().map((message) =>
    message.role === "user" && message.id === localId
      ? { ...message, status: statusText }
      : message,
  );

  setStoredMessages(messages);
}

function getPendingConversations() {
  return getStorageJson(STORAGE_KEYS.pendingConversations, []);
}

function syncPendingConversations(state) {
  setStorageItem(
    STORAGE_KEYS.pendingConversations,
    JSON.stringify(Array.from(state.pendingConversations.values())),
  );
}

function isDifferentStoredMessage(message, storedMessage) {
  return message.id !== storedMessage.id || message.role !== storedMessage.role;
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return WORKER_BASE_ORIGIN;
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Worker URL must start with http:// or https://.");
  }

  return url.origin;
}

async function workerFetch(pathname, options) {
  const auth = getStorageItem(STORAGE_KEYS.auth);
  const apiBase = getStorageItem(STORAGE_KEYS.apiBase) || WORKER_BASE_URL;
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

async function createResponseError(response) {
  const message =
    response.status === 401
      ? "Authentication failed. Please re-enter your passphrase."
      : response.status === 429
        ? "Too many requests. Please wait a moment."
        : await getErrorMessage(response);
  const retryAfterSeconds = Number.parseInt(response.headers.get("Retry-After") || "", 10);

  return Object.assign(new Error(message), {
    retryAfterMs:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : POLL_INTERVAL_MS * 2,
    status: response.status,
  });
}

function isNetworkFailure(error) {
  return error instanceof TypeError;
}

function normalizePollDelay(cacheTtlSeconds) {
  return Math.max(POLL_INTERVAL_MS, Number(cacheTtlSeconds || 0) * 1000);
}

function getBackoffDelay(error) {
  return error.retryAfterMs || POLL_INTERVAL_MS * 2;
}

function scheduleQueueDrain(elements, state, delayMs) {
  if (state.queueRetryTimer) {
    window.clearTimeout(state.queueRetryTimer);
  }

  state.queueRetryTimer = window.setTimeout(() => {
    state.queueRetryTimer = 0;

    if (navigator.onLine) {
      void drainQueue(elements, state);
    }
  }, delayMs);
}

function handleAuthenticationFailure(elements, state, localId) {
  stopPollingLoop(state);
  setStorageItem(STORAGE_KEYS.auth, "");
  elements.passphrase.value = "";
  toggleSetupPanel(elements, true);
  updateConnectionUi(elements);
  updateQueueStatus(elements);
  showFlashMessage(elements, "Authentication failed. Please re-enter your passphrase.", true);

  if (localId) {
    updateMessageStatus(
      elements,
      localId,
      "Authentication failed. Please re-enter your passphrase.",
      true,
    );
  }

  elements.passphrase.focus();
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
    const serviceWorkerUrl = new URL(SERVICE_WORKER_PATH, window.location.href).toString();
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
