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
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_VOICE_MEMO_DURATION_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const SERVICE_WORKER_PATH = "sw.js";
const ATTACHMENT_DOWNLOAD_URLS = new Map();
const VOICE_MEMO_READY_TEXT = "Voice memo ready.";
const VOICE_MEMO_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
let fallbackMessageCounter = 0;
let fallbackAttachmentCounter = 0;

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
    composerAttachments: [],
    isDrainingQueue: false,
    pendingConversations: new Map(
      getPendingConversations().map((conversation) => [conversation.conversationId, conversation]),
    ),
    pollTimer: 0,
    queueRetryTimer: 0,
    voiceMemo: createVoiceMemoState(),
  };

  hydrateSetupForm(elements);
  initializeVoiceMemo(elements, state);
  renderStoredMessages(elements);
  renderQueuedMessages(elements);
  renderPendingAttachments(elements, state);
  updateConnectivity(elements);
  updateQueueStatus(elements);
  updateConnectionUi(elements);
  refreshComposerControls(elements, state);
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
      refreshComposerControls(elements, state);
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

  elements.attachmentButton.addEventListener("click", () => {
    if (!getStorageItem(STORAGE_KEYS.auth)) {
      toggleSetupPanel(elements, true);
      showFlashMessage(elements, "Save your passphrase before adding attachments.", true);
      elements.passphrase.focus();
      return;
    }

    elements.attachmentInput.click();
  });

  elements.attachmentInput.addEventListener("change", () => {
    const files = Array.from(elements.attachmentInput.files || []);
    elements.attachmentInput.value = "";

    if (!files.length) {
      return;
    }

    void handleAttachmentSelection(files, elements, state);
  });

  elements.attachmentPreviews.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-attachment]");
    if (!removeButton) {
      return;
    }

    removeComposerAttachment(removeButton.dataset.removeAttachment, elements, state);
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const text = elements.messageInput.value.trim();
      if (!text) {
        return;
      }

      if (state.composerAttachments.some((attachment) => attachment.status === "uploading")) {
        showFlashMessage(elements, "Wait for attachments to finish uploading before sending.", true);
        return;
      }

      if (state.composerAttachments.some((attachment) => attachment.status === "error")) {
        showFlashMessage(elements, "Remove failed attachments before sending your message.", true);
        return;
      }

      if (!getStorageItem(STORAGE_KEYS.auth)) {
        toggleSetupPanel(elements, true);
        showFlashMessage(elements, "Save your passphrase before sending a message.", true);
        elements.passphrase.focus();
        return;
      }

      const messageAttachments = consumeComposerAttachments(elements, state);
      const localMessage = createLocalMessage(text, messageAttachments);
      appendMessage(elements, {
        author: "You",
        attachments: messageAttachments,
        localId: localMessage.localId,
        status: navigator.onLine ? "Sending…" : "Queued for delivery",
        text: localMessage.text,
        timestamp: localMessage.createdAt,
        variant: "user",
      });

      elements.messageInput.value = "";
      renderPendingAttachments(elements, state);
      refreshComposerControls(elements, state);

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
    attachmentButton: document.getElementById("attachment-button"),
    attachmentInput: document.getElementById("attachment-input"),
    attachmentPreviews: document.getElementById("attachment-previews"),
    attachmentStatus: document.getElementById("attachment-status"),
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
    voiceMemoAttachButton: document.getElementById("voice-memo-attach"),
    voiceMemoAudio: document.getElementById("voice-memo-audio"),
    voiceMemoButton: document.getElementById("voice-memo-button"),
    voiceMemoButtonText: document.getElementById("voice-memo-button-text"),
    voiceMemoElapsed: document.getElementById("voice-memo-elapsed"),
    voiceMemoPanel: document.getElementById("voice-memo-panel"),
    voiceMemoPreview: document.getElementById("voice-memo-preview"),
    voiceMemoPreviewSummary: document.getElementById("voice-memo-preview-summary"),
    voiceMemoRecording: document.getElementById("voice-memo-recording"),
    voiceMemoRerecordButton: document.getElementById("voice-memo-rerecord"),
    voiceMemoStatus: document.getElementById("voice-memo-status"),
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
  elements.attachmentButton.disabled = !hasAuth;
  elements.attachmentInput.disabled = !hasAuth;
  elements.messageInput.disabled = !hasAuth;
  elements.sendButton.disabled = !hasAuth;
  elements.connectionSettings.textContent = hasAuth
    ? "Update connection"
    : "Connection settings";
}

function refreshComposerControls(elements, state) {
  const hasAuth = Boolean(getStorageItem(STORAGE_KEYS.auth));
  const hasUploadingAttachment = state.composerAttachments.some(
    (attachment) => attachment.status === "uploading",
  );
  const canAddMoreAttachments = state.composerAttachments.length < MAX_ATTACHMENT_COUNT;
  const isRecordingVoiceMemo = state.voiceMemo.isRecording;

  elements.attachmentButton.disabled = !hasAuth || !canAddMoreAttachments || isRecordingVoiceMemo;
  elements.attachmentInput.disabled = !hasAuth || !canAddMoreAttachments || isRecordingVoiceMemo;
  elements.sendButton.disabled = !hasAuth || hasUploadingAttachment || isRecordingVoiceMemo;

  if (elements.voiceMemoButton) {
    elements.voiceMemoButton.disabled =
      !state.voiceMemo.isSupported ||
      !hasAuth ||
      (!canAddMoreAttachments && !isRecordingVoiceMemo);
  }

  if (elements.voiceMemoAttachButton) {
    elements.voiceMemoAttachButton.disabled =
      !hasAuth ||
      !state.voiceMemo.recordedBlob ||
      !canAddMoreAttachments ||
      isRecordingVoiceMemo;
  }
}

async function handleAttachmentSelection(files, elements, state) {
  const remainingSlots = MAX_ATTACHMENT_COUNT - state.composerAttachments.length;

  if (remainingSlots <= 0) {
    showFlashMessage(
      elements,
      `You can attach up to ${MAX_ATTACHMENT_COUNT} files per message.`,
      true,
    );
    return;
  }

  if (files.length > remainingSlots) {
    showFlashMessage(
      elements,
      `Only ${remainingSlots} more attachment${remainingSlots === 1 ? "" : "s"} can be added.`,
      true,
    );
  }

  for (const file of files.slice(0, remainingSlots)) {
    const validationError = validateAttachmentFile(file);

    if (validationError) {
      showFlashMessage(elements, validationError, true);
      continue;
    }

    startAttachmentUpload(file, elements, state);
  }
}

function validateAttachmentFile(file) {
  if (!file?.type || !isAllowedAttachmentContentType(file.type)) {
    return `${file?.name || "This file"} is not a supported image, PDF, text file, or audio clip.`;
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is larger than 25 MB. Choose a smaller file.`;
  }

  return null;
}

function isAllowedAttachmentContentType(contentType) {
  const normalized = normalizeAttachmentContentType(contentType);

  return (
    normalized === "application/pdf" ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("image/") ||
    normalized.startsWith("text/")
  );
}

function normalizeAttachmentContentType(contentType) {
  return String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function startAttachmentUpload(file, elements, state) {
  fallbackAttachmentCounter += 1;

  const attachment = {
    contentType: normalizeAttachmentContentType(file.type),
    id:
      globalThis.crypto?.randomUUID?.() ||
      `attachment-${Date.now()}-${fallbackAttachmentCounter}-${Math.random().toString(16).slice(2)}`,
    key: "",
    name: file.name,
    previewUrl: null,
    progress: 0,
    sizeBytes: file.size,
    status: "uploading",
    cancelUpload: null,
  };

  state.composerAttachments.push(attachment);
  renderPendingAttachments(elements, state);
  refreshComposerControls(elements, state);
  announce(elements, `Uploading ${attachment.name}.`);

  const previewPromise = createAttachmentPreview(file, attachment.contentType);

  void (async () => {
    try {
      const { key, uploadUrl } = await requestUploadReservation(file);
      attachment.key = key;
      attachment.previewUrl = await previewPromise.catch(() => null);
      await uploadAttachmentFile(uploadUrl, file, (progress) => {
        attachment.progress = progress;
        renderPendingAttachments(elements, state);
      }, attachment);

      if (!state.composerAttachments.some((item) => item.id === attachment.id)) {
        return;
      }

      attachment.progress = 100;
      attachment.status = "uploaded";
      renderPendingAttachments(elements, state);
      refreshComposerControls(elements, state);
      announce(elements, `${attachment.name} uploaded.`);
    } catch (error) {
      if (!state.composerAttachments.some((item) => item.id === attachment.id)) {
        return;
      }

      if (error?.aborted) {
        return;
      }

      attachment.status = "error";
      renderPendingAttachments(elements, state);
      refreshComposerControls(elements, state);

      if (error.status === 401) {
        handleAuthenticationFailure(elements, state);
        return;
      }

      showFlashMessage(elements, getAttachmentErrorMessage(attachment.name, error), true);
    }
  })();
}

async function requestUploadReservation(file) {
  const response = await workerFetch("/api/upload-url", {
    body: JSON.stringify({
      contentType: normalizeAttachmentContentType(file.type),
      filename: file.name,
      sizeBytes: file.size,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw await createResponseError(response);
  }

  return response.json();
}

function uploadAttachmentFile(uploadUrl, file, onProgress, attachment) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    attachment.cancelUpload = () => request.abort();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", normalizeAttachmentContentType(file.type));
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      // Keep 100% reserved for a confirmed server response so the UI does not
      // imply success before S3 accepts the upload.
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    });
    request.addEventListener("load", () => {
      attachment.cancelUpload = null;

      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }

      reject(new Error(`Upload failed with status ${request.status}.`));
    });
    request.addEventListener("error", () => {
      attachment.cancelUpload = null;
      reject(new Error("Upload failed. Check your connection and try again."));
    });
    request.addEventListener("abort", () => {
      attachment.cancelUpload = null;
      reject(Object.assign(new Error("Upload aborted"), { aborted: true }));
    });
    request.send(file);
  });
}

function createAttachmentPreview(file, contentType) {
  if (contentType.startsWith("audio/")) {
    return Promise.resolve(URL.createObjectURL(file));
  }

  if (!contentType.startsWith("image/")) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : null));
    reader.addEventListener("error", () => reject(new Error("The image preview could not be generated.")));
    reader.readAsDataURL(file);
  });
}

function removeComposerAttachment(attachmentId, elements, state) {
  const attachmentIndex = state.composerAttachments.findIndex(
    (attachment) => attachment.id === attachmentId,
  );

  if (attachmentIndex < 0) {
    return;
  }

  const [attachment] = state.composerAttachments.splice(attachmentIndex, 1);
  attachment.cancelUpload?.();

  renderPendingAttachments(elements, state);
  refreshComposerControls(elements, state);
  announce(elements, `${attachment.name} removed.`);
}

function consumeComposerAttachments(elements, state) {
  const attachments = state.composerAttachments.map((attachment) =>
    createStoredAttachment(attachment, true),
  );
  state.composerAttachments = [];

  return attachments;
}

function renderPendingAttachments(elements, state) {
  const attachments = state.composerAttachments;
  elements.attachmentPreviews.innerHTML = "";
  elements.attachmentPreviews.classList.toggle("is-hidden", attachments.length === 0);

  for (const attachment of attachments) {
    const article = document.createElement("article");
    article.className = "attachment-preview";
    article.dataset.attachmentId = attachment.id;

    const header = document.createElement("div");
    header.className = "attachment-preview-header";

    const details = document.createElement("div");
    details.className = "attachment-preview-details";

    const name = document.createElement("p");
    name.className = "attachment-preview-name";
    name.textContent = attachment.name;

    const meta = document.createElement("p");
    meta.className = "attachment-preview-meta";
    meta.textContent = `${formatAttachmentSize(attachment.sizeBytes)} · ${getAttachmentStatusText(attachment)}`;

    details.append(name, meta);

    const removeButton = document.createElement("button");
    removeButton.className = "secondary-button attachment-remove-button";
    removeButton.dataset.removeAttachment = attachment.id;
    removeButton.type = "button";
    removeButton.textContent = "Remove";

    header.append(details, removeButton);
    article.append(header);

    if (attachment.previewUrl) {
      if (attachment.contentType.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.className = "attachment-preview-audio";
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = attachment.previewUrl;
        article.append(audio);
      } else {
        const preview = document.createElement("img");
        preview.alt = `Preview of ${attachment.name}`;
        preview.className = "attachment-preview-image";
        preview.src = attachment.previewUrl;
        article.append(preview);
      }
    }

    const status = document.createElement("p");
    status.className = "attachment-preview-status";
    status.textContent = getAttachmentStatusText(attachment);
    status.classList.toggle("is-error", attachment.status === "error");
    article.append(status);
    elements.attachmentPreviews.append(article);
  }

  elements.attachmentStatus.textContent = getAttachmentSummary(attachments);
}

function getAttachmentStatusText(attachment) {
  if (attachment.status === "error") {
    return "Upload failed";
  }

  if (attachment.status === "uploaded") {
    return "Uploaded";
  }

  return `Uploading… ${attachment.progress}%`;
}

function getAttachmentSummary(attachments) {
  if (!attachments.length) {
    return "";
  }

  const uploadingCount = attachments.filter((attachment) => attachment.status === "uploading").length;
  const readyCount = attachments.filter((attachment) => attachment.status === "uploaded").length;

  if (uploadingCount > 0) {
    return `${readyCount} ready, ${uploadingCount} uploading.`;
  }

  return `${readyCount} attachment${readyCount === 1 ? "" : "s"} ready to send.`;
}

function getAttachmentErrorMessage(name, error) {
  if (error instanceof Error && error.message) {
    return `${name} could not be uploaded. ${error.message}`;
  }

  return `${name} could not be uploaded.`;
}

function formatAttachmentSize(sizeBytes) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }

  return `${sizeBytes} B`;
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

function createLocalMessage(text, attachments = []) {
  fallbackMessageCounter += 1;

  return {
    attachments: serializeStoredAttachments(attachments),
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
        attachments: message.attachments.map((attachment) => attachment.key),
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
      attachments: message.attachments,
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
        attachments: normalizeStoredAttachments(message.attachments),
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

  if (Array.isArray(message.attachments) && message.attachments.length) {
    body.append(createMessageAttachments(elements, message.attachments));
  }

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
    attachments: serializeStoredAttachments(message.attachments),
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

function createStoredAttachment(attachment, includeLocalUrls = false) {
  return {
    contentType: attachment.contentType,
    key: attachment.key,
    linkUrl: includeLocalUrls ? attachment.linkUrl || null : null,
    name: attachment.name,
    previewUrl: includeLocalUrls ? attachment.previewUrl || null : null,
  };
}

function serializeStoredAttachments(attachments = []) {
  return attachments.map((attachment) => createStoredAttachment(attachment, false));
}

function normalizeStoredAttachments(attachments = []) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => ({
      contentType: attachment.contentType || "",
      key: attachment.key || "",
      linkUrl: attachment.linkUrl || null,
      name: getAttachmentDisplayName(attachment),
      previewUrl: attachment.previewUrl || null,
    }))
    .filter((attachment) => attachment.key || attachment.linkUrl || attachment.previewUrl);
}

function getAttachmentDisplayName(attachment) {
  return attachment.name || attachment.key || "Attachment";
}

function createMessageAttachments(elements, attachments) {
  const list = document.createElement("ul");
  list.className = "message-attachments";

  for (const attachment of attachments.map((item) => createStoredAttachment(item, true))) {
    const item = document.createElement("li");
    const name = getAttachmentDisplayName(attachment);
    const imageUrl = attachment.previewUrl || null;
    const linkUrl = attachment.linkUrl || null;

    if (attachment.contentType.startsWith("image/")) {
      const link = document.createElement("a");
      link.className = "message-attachment-link";
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const image = document.createElement("img");
      image.alt = `Preview of ${name}`;
      image.className = "message-attachment-image";
      image.hidden = !imageUrl;

      const label = document.createElement("span");
      label.textContent = name;

      if (imageUrl) {
        image.src = imageUrl;
      }

      if (linkUrl) {
        link.href = linkUrl;
      }

      link.append(image, label);
      item.append(link);

      if (!imageUrl && attachment.key) {
        void hydrateAttachmentLink(elements, attachment.key, link, image);
      }
    } else if (attachment.contentType.startsWith("audio/")) {
      const wrapper = document.createElement("div");
      wrapper.className = "message-attachment-audio";

      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.hidden = !imageUrl && !linkUrl;

      if (imageUrl || linkUrl) {
        audio.src = imageUrl || linkUrl;
      }

      const link = document.createElement("a");
      link.className = "message-attachment-link";
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      link.textContent = name;

      if (linkUrl) {
        link.href = linkUrl;
      }

      wrapper.append(audio, link);
      item.append(wrapper);

      if (attachment.key) {
        void hydrateAttachmentLink(elements, attachment.key, link, null, audio);
      }
    } else if (linkUrl) {
      const link = document.createElement("a");
      link.className = "message-attachment-link";
      link.href = linkUrl;
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      link.textContent = name;
      item.append(link);
    } else {
      const label = document.createElement("span");
      label.className = "message-attachment-name";
      label.textContent = name;
      item.append(label);

      if (attachment.key) {
        void hydrateAttachmentLink(elements, attachment.key, label);
      }
    }

    list.append(item);
  }

  return list;
}

async function hydrateAttachmentLink(elements, key, target, imageElement, audioElement) {
  try {
    const downloadUrl = await getAttachmentDownloadUrl(key);

    if (target.tagName.toUpperCase() === "A") {
      target.href = downloadUrl;
    } else {
      const link = document.createElement("a");
      link.className = "message-attachment-link";
      link.href = downloadUrl;
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      link.textContent = target.textContent;
      target.replaceWith(link);
    }

    if (imageElement) {
      imageElement.src = downloadUrl;
      imageElement.hidden = false;
    }

    if (audioElement) {
      audioElement.src = downloadUrl;
      audioElement.hidden = false;
    }
  } catch {
    announce(elements, "An attachment preview could not be loaded.");
  }
}

function createVoiceMemoState() {
  return {
    chunks: [],
    isRecording: false,
    isSupported: false,
    maxDurationTimerId: 0,
    mimeType: "",
    previewUrl: "",
    recordedBlob: null,
    recorder: null,
    startedAt: 0,
    stopReason: "",
    stream: null,
    timerId: 0,
    durationMs: 0,
  };
}

function initializeVoiceMemo(elements, state) {
  if (!elements.voiceMemoButton || !elements.voiceMemoPanel) {
    return;
  }

  state.voiceMemo.isSupported = supportsVoiceMemoRecording();
  elements.voiceMemoButton.hidden = !state.voiceMemo.isSupported;
  elements.voiceMemoButton.classList.toggle("is-hidden", !state.voiceMemo.isSupported);

  if (!state.voiceMemo.isSupported) {
    renderVoiceMemoState(elements, state);
    return;
  }

  elements.voiceMemoButton.addEventListener("click", () => {
    if (state.voiceMemo.isRecording) {
      stopVoiceMemoRecording(elements, state);
      return;
    }

    void startVoiceMemoRecording(elements, state);
  });

  elements.voiceMemoRerecordButton.addEventListener("click", () => {
    void restartVoiceMemoRecording(elements, state);
  });

  elements.voiceMemoAttachButton.addEventListener("click", () => {
    void attachVoiceMemo(elements, state);
  });

  renderVoiceMemoState(elements, state);
}

function supportsVoiceMemoRecording() {
  return (
    typeof globalThis.MediaRecorder === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function getSupportedVoiceMemoMimeType() {
  if (typeof globalThis.MediaRecorder?.isTypeSupported !== "function") {
    return VOICE_MEMO_MIME_TYPES[0];
  }

  return VOICE_MEMO_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

async function startVoiceMemoRecording(elements, state) {
  if (!getStorageItem(STORAGE_KEYS.auth)) {
    toggleSetupPanel(elements, true);
    showFlashMessage(elements, "Save your passphrase before recording a voice memo.", true);
    elements.passphrase.focus();
    return;
  }

  if (state.composerAttachments.length >= MAX_ATTACHMENT_COUNT) {
    showFlashMessage(
      elements,
      `You can attach up to ${MAX_ATTACHMENT_COUNT} files per message.`,
      true,
    );
    return;
  }

  clearVoiceMemoPreview(state);

  const mimeType = getSupportedVoiceMemoMimeType();
  let stream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    handleVoiceMemoPermissionError(elements, error);
    return;
  }

  let recorder;

  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    stopVoiceMemoStream(stream);
    showFlashMessage(elements, "Voice memo recording is not available in this browser.", true);
    return;
  }

  state.voiceMemo.chunks = [];
  state.voiceMemo.durationMs = 0;
  state.voiceMemo.isRecording = true;
  state.voiceMemo.mimeType = mimeType || normalizeAttachmentContentType(recorder.mimeType || "audio/webm");
  state.voiceMemo.previewUrl = "";
  state.voiceMemo.recordedBlob = null;
  state.voiceMemo.recorder = recorder;
  state.voiceMemo.startedAt = Date.now();
  state.voiceMemo.stopReason = "";
  state.voiceMemo.stream = stream;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) {
      state.voiceMemo.chunks.push(event.data);
    }
  });

  recorder.addEventListener("stop", () => {
    void finalizeVoiceMemoRecording(elements, state);
  });

  recorder.start();
  state.voiceMemo.timerId = window.setInterval(() => {
    state.voiceMemo.durationMs = Date.now() - state.voiceMemo.startedAt;
    renderVoiceMemoState(elements, state);
  }, 250);
  state.voiceMemo.maxDurationTimerId = window.setTimeout(() => {
    state.voiceMemo.stopReason = "max-duration";
    stopVoiceMemoRecording(elements, state);
  }, MAX_VOICE_MEMO_DURATION_MS);

  renderVoiceMemoState(elements, state);
  refreshComposerControls(elements, state);
  announceVoiceMemo(elements, "Voice memo recording started.");
}

function stopVoiceMemoRecording(elements, state) {
  const { recorder } = state.voiceMemo;

  if (!state.voiceMemo.isRecording || !recorder) {
    return;
  }

  state.voiceMemo.isRecording = false;
  state.voiceMemo.durationMs = Date.now() - state.voiceMemo.startedAt;
  clearVoiceMemoTimers(state);
  renderVoiceMemoState(elements, state);
  refreshComposerControls(elements, state);

  if (recorder.state !== "inactive") {
    recorder.stop();
  }
}

async function finalizeVoiceMemoRecording(elements, state) {
  const mimeType = normalizeAttachmentContentType(
    state.voiceMemo.recorder?.mimeType || state.voiceMemo.mimeType || "audio/webm",
  );
  const blob = new Blob(state.voiceMemo.chunks, {
    type: mimeType || "audio/webm",
  });

  stopVoiceMemoStream(state.voiceMemo.stream);
  state.voiceMemo.chunks = [];
  state.voiceMemo.recorder = null;
  state.voiceMemo.stream = null;

  if (!blob.size) {
    state.voiceMemo.mimeType = "";
    state.voiceMemo.recordedBlob = null;
    state.voiceMemo.durationMs = 0;
    renderVoiceMemoState(elements, state);
    refreshComposerControls(elements, state);
    showFlashMessage(elements, "The voice memo could not be recorded. Please try again.", true);
    return;
  }

  clearVoiceMemoPreview(state);
  state.voiceMemo.mimeType = mimeType || "audio/webm";
  state.voiceMemo.previewUrl = URL.createObjectURL(blob);
  state.voiceMemo.recordedBlob = blob;
  renderVoiceMemoState(elements, state);
  refreshComposerControls(elements, state);

  if (state.voiceMemo.stopReason === "max-duration") {
    showFlashMessage(elements, "Voice memo stopped after 5 minutes.");
    announceVoiceMemo(elements, "Voice memo stopped after 5 minutes.");
    return;
  }

  announceVoiceMemo(elements, "Voice memo recording stopped.");
}

async function restartVoiceMemoRecording(elements, state) {
  clearVoiceMemoPreview(state);
  renderVoiceMemoState(elements, state);
  refreshComposerControls(elements, state);
  await startVoiceMemoRecording(elements, state);
}

async function attachVoiceMemo(elements, state) {
  if (!state.voiceMemo.recordedBlob) {
    return;
  }

  if (state.composerAttachments.length >= MAX_ATTACHMENT_COUNT) {
    showFlashMessage(
      elements,
      `You can attach up to ${MAX_ATTACHMENT_COUNT} files per message.`,
      true,
    );
    return;
  }

  const file = createVoiceMemoFile(state.voiceMemo.recordedBlob, state.voiceMemo.mimeType);
  clearVoiceMemoPreview(state);
  renderVoiceMemoState(elements, state);
  refreshComposerControls(elements, state);
  announceVoiceMemo(elements, "Voice memo attached.");
  await handleAttachmentSelection([file], elements, state);
}

function createVoiceMemoFile(blob, mimeType) {
  const contentType = normalizeAttachmentContentType(mimeType) || "audio/webm";
  const extension = contentType === "audio/mp4" ? "mp4" : "webm";
  const timestampString = new Date().toISOString().replaceAll(":", "-");

  return new File([blob], `voice-memo-${timestampString}.${extension}`, {
    type: contentType,
  });
}

function clearVoiceMemoPreview(state) {
  if (state.voiceMemo.previewUrl) {
    URL.revokeObjectURL(state.voiceMemo.previewUrl);
  }

  state.voiceMemo.previewUrl = "";
  state.voiceMemo.recordedBlob = null;
  state.voiceMemo.durationMs = 0;
  state.voiceMemo.stopReason = "";
}

function clearVoiceMemoTimers(state) {
  if (state.voiceMemo.timerId) {
    window.clearInterval(state.voiceMemo.timerId);
    state.voiceMemo.timerId = 0;
  }

  if (state.voiceMemo.maxDurationTimerId) {
    window.clearTimeout(state.voiceMemo.maxDurationTimerId);
    state.voiceMemo.maxDurationTimerId = 0;
  }
}

function stopVoiceMemoStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function handleVoiceMemoPermissionError(elements, error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    showFlashMessage(
      elements,
      "Microphone access was denied. Allow microphone access in your browser's site settings to record a voice memo.",
      true,
    );
    announceVoiceMemo(elements, "Microphone access was denied.");
    return;
  }

  showFlashMessage(elements, "The microphone could not be started. Please try again.", true);
}

function renderVoiceMemoState(elements, state) {
  if (!elements.voiceMemoPanel || !elements.voiceMemoButton) {
    return;
  }

  const hasPreview = Boolean(state.voiceMemo.previewUrl);
  const isVisible = state.voiceMemo.isRecording || hasPreview;
  elements.voiceMemoPanel.classList.toggle("is-hidden", !isVisible);
  elements.voiceMemoRecording.classList.toggle("is-hidden", !state.voiceMemo.isRecording);
  elements.voiceMemoPreview.classList.toggle("is-hidden", !hasPreview);
  elements.voiceMemoButton.setAttribute("aria-pressed", String(state.voiceMemo.isRecording));
  elements.voiceMemoButtonText.textContent = state.voiceMemo.isRecording
    ? "Stop"
    : hasPreview
      ? "Re-record"
      : "Record";
  elements.voiceMemoButton.setAttribute(
    "aria-label",
    state.voiceMemo.isRecording
      ? "Stop voice memo recording"
      : hasPreview
        ? "Re-record voice memo"
        : "Record voice memo",
  );
  elements.voiceMemoElapsed.textContent = `Recording… ${formatElapsedTime(state.voiceMemo.durationMs)}`;

  if (hasPreview) {
    elements.voiceMemoAudio.src = state.voiceMemo.previewUrl;
    elements.voiceMemoPreviewSummary.textContent =
      `Voice memo ready. Duration: ${formatElapsedTime(state.voiceMemo.durationMs)}`;
  } else if (elements.voiceMemoAudio.hasAttribute("src")) {
    elements.voiceMemoAudio.removeAttribute("src");
    elements.voiceMemoAudio.load();
    elements.voiceMemoPreviewSummary.textContent = VOICE_MEMO_READY_TEXT;
  } else {
    elements.voiceMemoPreviewSummary.textContent = VOICE_MEMO_READY_TEXT;
  }
}

function announceVoiceMemo(elements, message) {
  if (elements.voiceMemoStatus) {
    elements.voiceMemoStatus.textContent = message;
  }
}

function formatElapsedTime(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function getAttachmentDownloadUrl(key) {
  if (ATTACHMENT_DOWNLOAD_URLS.has(key)) {
    return ATTACHMENT_DOWNLOAD_URLS.get(key);
  }

  const response = await workerFetch(`/api/attachment?key=${encodeURIComponent(key)}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw await createResponseError(response);
  }

  const payload = await response.json();
  ATTACHMENT_DOWNLOAD_URLS.set(key, payload.downloadUrl);
  return payload.downloadUrl;
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
  refreshComposerControls(elements, state);
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
