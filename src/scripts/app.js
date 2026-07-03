/**
 * Woodwire PWA — Main Script
 *
 * Handles theme persistence, connection setup, offline queueing, service worker
 * registration, message sending, and polling for bot responses.
 */

"use strict";

const STORAGE_KEYS = {
  apiBase: "woodwire_api_base",
  autoplay: "woodwire_autoplay",
  auth: "woodwire_auth",
  e2eeKey: "woodwire_e2ee_key",
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
const ATTACHMENT_AUDIO_URLS = new Map();
const VOICE_RESPONSE_AUDIO_URLS = new Map();
const VOICE_MEMO_READY_TEXT = "Voice memo ready.";
const VOICE_MEMO_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const VOICE_RESPONSE_NO_TRANSCRIPT_TEXT = "Voice response — no transcript available";
const E2EE_IV_LENGTH_BYTES = 12;
const E2EE_KEY_LENGTH_BYTES = 32;
// Encode in 32 KB slices to avoid exceeding Function.apply / spread call limits.
const BASE64_ENCODING_CHUNK_BYTES = 0x8000;
const DEFAULT_DECRYPTION_FAILURE_MESSAGE =
  "Unable to decrypt data. Check that your saved E2EE key matches your bot.";
let fallbackMessageCounter = 0;
let fallbackAttachmentCounter = 0;
let importedE2eeKeyValue = "";
let importedE2eeKeyPromise = null;

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
      const e2eeKey = normalizeStoredE2eeKey(elements.e2eeKey.value);

      if (!passphrase) {
        showFlashMessage(elements, "Enter a passphrase before continuing.", true);
        elements.passphrase.focus();
        return;
      }

      setStorageItem(STORAGE_KEYS.apiBase, apiBaseUrl);
      setStorageItem(STORAGE_KEYS.auth, passphrase);
      setStorageItem(STORAGE_KEYS.e2eeKey, e2eeKey);
      setVoiceAutoplayPreference(elements.autoplayVoice?.checked);
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

  elements.autoplayVoice?.addEventListener("change", () => {
    setVoiceAutoplayPreference(elements.autoplayVoice.checked);
    announce(
      elements,
      elements.autoplayVoice.checked
        ? "Voice reply autoplay enabled."
        : "Voice reply autoplay disabled.",
    );
  });

  elements.attachmentButton.addEventListener("click", () => {
    if (!hasSavedConnectionCredentials()) {
      toggleSetupPanel(elements, true);
      showFlashMessage(elements, "Save your passphrase and E2EE key before adding attachments.", true);
      focusSetupField(elements);
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

      if (!hasSavedConnectionCredentials()) {
        toggleSetupPanel(elements, true);
        showFlashMessage(elements, "Save your passphrase and E2EE key before sending a message.", true);
        focusSetupField(elements);
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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPollingLoop(state);
    } else if (state.pendingConversations.size > 0) {
      ensurePollingLoop(elements, state);
    }
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
    autoplayVoice: document.getElementById("autoplay-voice"),
    composer: document.getElementById("composer"),
    connectionSettings: document.getElementById("connection-settings"),
    e2eeKey: document.getElementById("e2ee-key"),
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
  elements.e2eeKey.value = getStorageItem(STORAGE_KEYS.e2eeKey) || "";
  if (elements.autoplayVoice) {
    elements.autoplayVoice.checked = isVoiceAutoplayEnabled();
  }
  toggleSetupPanel(elements, !hasSavedConnectionCredentials());
}

function updateConnectionUi(elements) {
  const hasConnectionDetails = hasSavedConnectionCredentials();
  elements.attachmentButton.disabled = !hasConnectionDetails;
  elements.attachmentInput.disabled = !hasConnectionDetails;
  elements.messageInput.disabled = !hasConnectionDetails;
  elements.sendButton.disabled = !hasConnectionDetails;
  elements.connectionSettings.textContent = hasConnectionDetails
    ? "Update connection"
    : "Connection settings";
}

function refreshComposerControls(elements, state) {
  const hasConnectionDetails = hasSavedConnectionCredentials();
  const hasUploadingAttachment = state.composerAttachments.some(
    (attachment) => attachment.status === "uploading",
  );
  const canAddMoreAttachments = state.composerAttachments.length < MAX_ATTACHMENT_COUNT;
  const isRecordingVoiceMemo = state.voiceMemo.isRecording;

  elements.attachmentButton.disabled =
    !hasConnectionDetails || !canAddMoreAttachments || isRecordingVoiceMemo;
  elements.attachmentInput.disabled =
    !hasConnectionDetails || !canAddMoreAttachments || isRecordingVoiceMemo;
  elements.sendButton.disabled =
    !hasConnectionDetails || hasUploadingAttachment || isRecordingVoiceMemo;

  if (elements.voiceMemoButton) {
    elements.voiceMemoButton.disabled =
      !state.voiceMemo.isSupported ||
      !hasConnectionDetails ||
      (!canAddMoreAttachments && !isRecordingVoiceMemo);
  }

  if (elements.voiceMemoAttachButton) {
    elements.voiceMemoAttachButton.disabled =
    !hasConnectionDetails ||
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
    encrypted: normalizeAttachmentContentType(file.type).startsWith("audio/"),
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
      const uploadFile = attachment.encrypted ? await encryptAttachmentFile(file) : file;
      const { key, uploadUrl } = await requestUploadReservation(file, uploadFile.size);
      attachment.key = key;
      attachment.previewUrl = await previewPromise.catch(() => null);
      await uploadAttachmentFile(uploadUrl, uploadFile, (progress) => {
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

async function requestUploadReservation(file, sizeBytes = file.size) {
  const response = await workerFetch("/api/upload-url", {
    body: JSON.stringify({
      contentType: normalizeAttachmentContentType(file.type),
      filename: file.name,
      sizeBytes,
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
    const encryptedText = await encryptMessageText(message.text);
    const response = await workerFetch("/api/message", {
      body: JSON.stringify({
        attachments: message.attachments.map((attachment) => attachment.key),
        schemaVersion: 2,
        text: encryptedText,
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
    !hasSavedConnectionCredentials()
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
        ? payload.hasAudio
          ? "Voice reply ready"
          : "Reply ready"
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
  let transcript = normalizeAssistantTranscript(payload.transcript);
  const transcriptUrl = normalizeVoiceResponseAudioUrl(payload.transcriptUrl);
  if (!transcript && transcriptUrl) {
    try {
      transcript = await fetchEncryptedTextPayload(transcriptUrl);
    } catch (error) {
      if (!isDecryptionFailure(error)) {
        throw error;
      }

      appendMessage(elements, {
        author: "AI",
        conversationId: conversation.conversationId,
        responseFor: conversation.conversationId,
        text: "Unable to decrypt AI reply. Check your saved E2EE key.",
        timestamp: new Date().toISOString(),
        variant: "assistant",
      });
      showFlashMessage(elements, error.message, true);
      announce(elements, "The AI reply could not be decrypted.");
      return;
    }
  }
  const audioUrl = normalizeVoiceResponseAudioUrl(payload.audioUrl);
  appendMessage(elements, {
    author: "AI",
    conversationId: conversation.conversationId,
    responseFor: conversation.conversationId,
    text: getAssistantReplyText(transcript, audioUrl),
    timestamp: new Date().toISOString(),
    variant: "assistant",
    voiceResponse: audioUrl
      ? {
          conversationId: conversation.conversationId,
          audioUrl,
          encrypted: true,
          hasAudio: true,
        }
      : null,
  });
  announce(
    elements,
    audioUrl
      ? transcript
        ? "AI voice reply received with transcript."
        : "AI voice reply received without transcript."
      : "AI reply received.",
  );
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
        voiceResponse:
          message.role === "ai"
            ? normalizeStoredVoiceResponse(message.voiceResponse, message.conversationId)
            : null,
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

  if (message.voiceResponse?.hasAudio) {
    body.append(createVoiceResponsePlayer(elements, message.voiceResponse));
  }

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
  const hasConnectionDetails = hasSavedConnectionCredentials();

  if (!hasConnectionDetails) {
    elements.queueStatus.textContent = "Save your passphrase and E2EE key to start sending messages.";
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
    voiceResponse: serializeStoredVoiceResponse(message.voiceResponse),
  };
  const messages = getStoredMessages().filter((item) =>
    isDifferentStoredMessage(item, storedMessage),
  );

  messages.push(storedMessage);
  setStoredMessages(messages);
}

function serializeStoredVoiceResponse(voiceResponse) {
  if (!voiceResponse?.hasAudio || !voiceResponse.conversationId) {
    return null;
  }

  return {
    conversationId: voiceResponse.conversationId,
    encrypted: Boolean(voiceResponse.encrypted),
    hasAudio: true,
  };
}

function normalizeStoredVoiceResponse(voiceResponse, fallbackConversationId) {
  const conversationId = voiceResponse?.conversationId || fallbackConversationId;
  if (!voiceResponse?.hasAudio || !conversationId) {
    return null;
  }

  return {
    conversationId,
    encrypted: Boolean(voiceResponse.encrypted),
    hasAudio: true,
  };
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
    encrypted: Boolean(attachment.encrypted),
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
      encrypted: Boolean(attachment.encrypted),
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
        void hydrateAttachmentLink(
          elements,
          attachment.key,
          link,
          null,
          audio,
          attachment.contentType,
          attachment.encrypted,
        );
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

function createVoiceResponsePlayer(elements, voiceResponse) {
  const wrapper = document.createElement("div");
  wrapper.className = "voice-response";
  wrapper.setAttribute("aria-label", "Voice response");
  wrapper.setAttribute("role", "region");

  const loadingIndicator = document.createElement("p");
  loadingIndicator.className = "voice-response-loading";
  loadingIndicator.setAttribute("role", "status");
  loadingIndicator.textContent = "Downloading audio…";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.hidden = true;
  audio.preload = "metadata";
  audio.setAttribute("aria-label", "AI voice response");

  const source = document.createElement("source");
  source.type = "audio/mpeg";
  audio.append(source, "Your browser does not support audio playback.");
  wrapper.append(loadingIndicator, audio);

  void hydrateVoiceResponseAudio(elements, voiceResponse, audio, source, loadingIndicator);

  return wrapper;
}

async function hydrateVoiceResponseAudio(elements, voiceResponse, audio, source, loadingIndicator) {
  try {
    const responseAudioUrl = normalizeVoiceResponseAudioUrl(voiceResponse.audioUrl);
    let audioUrl = responseAudioUrl;

    if (voiceResponse.encrypted !== false) {
      audioUrl = await getVoiceResponseAudioObjectUrl(
        voiceResponse.conversationId,
        responseAudioUrl,
      );
    } else if (!audioUrl) {
      audioUrl = await getVoiceResponseAudioUrl(voiceResponse.conversationId);
    }

    if (voiceResponse.conversationId) {
      VOICE_RESPONSE_AUDIO_URLS.set(voiceResponse.conversationId, audioUrl);
    }

    audio.addEventListener(
      "loadedmetadata",
      () => {
        audio.hidden = false;
        loadingIndicator.hidden = true;

        if (isVoiceAutoplayEnabled()) {
          void attemptVoiceResponseAutoplay(audio);
        }
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        loadingIndicator.textContent = "Audio could not be loaded.";
      },
      { once: true },
    );

    source.src = audioUrl;
    audio.load();
  } catch (error) {
    loadingIndicator.textContent = isDecryptionFailure(error)
      ? "Audio could not be decrypted. Check your saved E2EE key."
      : "Audio could not be loaded.";
    announce(
      elements,
      isDecryptionFailure(error)
        ? "The voice response audio could not be decrypted."
        : "The voice response audio could not be loaded.",
    );
  }
}

async function attemptVoiceResponseAutoplay(audio) {
  try {
    await audio.play();
  } catch {
    // Autoplay is optional and may be blocked by browser policy.
  }
}

async function hydrateAttachmentLink(
  elements,
  key,
  target,
  imageElement,
  audioElement,
  contentType = "",
  isEncrypted = false,
) {
  try {
    const downloadUrl =
      audioElement && isEncrypted
        ? await getDecryptedAttachmentAudioUrl(key, contentType)
        : await getAttachmentDownloadUrl(key);

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
  } catch (error) {
    announce(
      elements,
      isDecryptionFailure(error)
        ? "An attachment preview could not be decrypted."
        : "An attachment preview could not be loaded.",
    );
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
  if (!hasSavedConnectionCredentials()) {
    toggleSetupPanel(elements, true);
    showFlashMessage(elements, "Save your passphrase and E2EE key before recording a voice memo.", true);
    focusSetupField(elements);
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
  }

  if (!hasPreview) {
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

async function getVoiceResponseAudioUrl(conversationId) {
  if (!conversationId) {
    throw new Error("Missing conversation ID");
  }

  if (VOICE_RESPONSE_AUDIO_URLS.has(conversationId)) {
    return VOICE_RESPONSE_AUDIO_URLS.get(conversationId);
  }

  const response = await workerFetch(`/api/response/${conversationId}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw await createResponseError(response);
  }

  const payload = await response.json();
  const audioUrl = normalizeVoiceResponseAudioUrl(payload.audioUrl);

  if (!audioUrl) {
    throw new Error("Audio response unavailable");
  }

  VOICE_RESPONSE_AUDIO_URLS.set(conversationId, audioUrl);
  return audioUrl;
}

async function getVoiceResponseAudioObjectUrl(conversationId, downloadUrl = "") {
  if (!conversationId) {
    throw new Error("Missing conversation ID");
  }

  if (VOICE_RESPONSE_AUDIO_URLS.has(conversationId)) {
    return VOICE_RESPONSE_AUDIO_URLS.get(conversationId);
  }

  const signedUrl = downloadUrl || (await getVoiceResponseAudioUrl(conversationId));
  const objectUrl = await decryptBinaryDownload(signedUrl, "audio/mpeg");
  VOICE_RESPONSE_AUDIO_URLS.set(conversationId, objectUrl);
  return objectUrl;
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

function hasSavedConnectionCredentials() {
  const auth = getStorageItem(STORAGE_KEYS.auth);
  if (!auth) {
    return false;
  }

  try {
    normalizeStoredE2eeKey(getStorageItem(STORAGE_KEYS.e2eeKey) || "");
    return true;
  } catch {
    return false;
  }
}

function focusSetupField(elements) {
  if (!getStorageItem(STORAGE_KEYS.auth)) {
    elements.passphrase.focus();
    return;
  }

  elements.e2eeKey.focus();
}

function normalizeAssistantTranscript(value) {
  return typeof value === "string" ? value : "";
}

function normalizeVoiceResponseAudioUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmedValue = value.trim();
  return trimmedValue || "";
}

function getAssistantReplyText(transcript, audioUrl) {
  if (transcript) {
    return transcript;
  }

  if (audioUrl) {
    return VOICE_RESPONSE_NO_TRANSCRIPT_TEXT;
  }

  return "The bot returned an empty reply.";
}

function isVoiceAutoplayEnabled() {
  return getStorageItem(STORAGE_KEYS.autoplay) === "true";
}

function setVoiceAutoplayPreference(isEnabled) {
  setStorageItem(STORAGE_KEYS.autoplay, String(Boolean(isEnabled)));
}

function normalizeStoredE2eeKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error("Encryption key is required.");
  }

  const decodedBytes = decodeBase64Bytes(trimmed);
  if (decodedBytes.byteLength !== E2EE_KEY_LENGTH_BYTES) {
    throw new Error("Encryption key must decode to exactly 32 bytes.");
  }

  return trimmed;
}

async function getImportedE2eeKey() {
  const keyValue = normalizeStoredE2eeKey(getStorageItem(STORAGE_KEYS.e2eeKey) || "");

  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is unavailable in this browser.");
  }

  if (keyValue !== importedE2eeKeyValue) {
    importedE2eeKeyValue = keyValue;
    importedE2eeKeyPromise = globalThis.crypto.subtle.importKey(
      "raw",
      decodeBase64Bytes(keyValue),
      { name: "AES-GCM" },
      false,
      ["decrypt", "encrypt"],
    );
  }

  return importedE2eeKeyPromise;
}

async function encryptMessageText(text) {
  const plaintextBytes = new TextEncoder().encode(text);
  const ciphertextBytes = await encryptPayloadBytes(plaintextBytes);
  return encodeBase64Bytes(ciphertextBytes);
}

async function encryptAttachmentFile(file) {
  const plaintextBytes = new Uint8Array(await file.arrayBuffer());
  const ciphertextBytes = await encryptPayloadBytes(plaintextBytes);
  return new Blob([ciphertextBytes], {
    type: normalizeAttachmentContentType(file.type) || "application/octet-stream",
  });
}

async function fetchEncryptedTextPayload(downloadUrl) {
  const ciphertextBytes = await fetchDownloadBytes(downloadUrl);
  const plaintextBytes = await decryptPayloadBytes(
    ciphertextBytes,
    "Unable to decrypt AI reply. Check your saved E2EE key.",
  );
  return new TextDecoder().decode(plaintextBytes);
}

async function getDecryptedAttachmentAudioUrl(key, contentType) {
  if (ATTACHMENT_AUDIO_URLS.has(key)) {
    return ATTACHMENT_AUDIO_URLS.get(key);
  }

  const downloadUrl = await getAttachmentDownloadUrl(key);
  const objectUrl = await decryptBinaryDownload(downloadUrl, contentType);
  ATTACHMENT_AUDIO_URLS.set(key, objectUrl);
  return objectUrl;
}

async function decryptBinaryDownload(downloadUrl, contentType) {
  const ciphertextBytes = await fetchDownloadBytes(downloadUrl);
  const plaintextBytes = await decryptPayloadBytes(
    ciphertextBytes,
    "Unable to decrypt data. Check your saved E2EE key.",
  );
  const decryptedBlob = new Blob([plaintextBytes], {
    type: contentType || "application/octet-stream",
  });
  return URL.createObjectURL(decryptedBlob);
}

async function fetchDownloadBytes(downloadUrl) {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}.`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function encryptPayloadBytes(plaintextBytes) {
  const encryptionKey = await getImportedE2eeKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(E2EE_IV_LENGTH_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { iv, name: "AES-GCM" },
    encryptionKey,
    plaintextBytes,
  );

  return concatByteArrays(iv, new Uint8Array(ciphertext));
}

async function decryptPayloadBytes(ciphertextBytes, message = DEFAULT_DECRYPTION_FAILURE_MESSAGE) {
  if (ciphertextBytes.byteLength <= E2EE_IV_LENGTH_BYTES) {
    throw createDecryptionFailure(message);
  }

  const encryptionKey = await getImportedE2eeKey();
  const iv = ciphertextBytes.slice(0, E2EE_IV_LENGTH_BYTES);
  const ciphertext = ciphertextBytes.slice(E2EE_IV_LENGTH_BYTES);

  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { iv, name: "AES-GCM" },
      encryptionKey,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw createDecryptionFailure(message);
  }
}

function concatByteArrays(firstBytes, secondBytes) {
  const combinedBytes = new Uint8Array(firstBytes.byteLength + secondBytes.byteLength);
  combinedBytes.set(firstBytes, 0);
  combinedBytes.set(secondBytes, firstBytes.byteLength);
  return combinedBytes;
}

function encodeBase64Bytes(bytes) {
  const binaryChunks = [];
  for (let index = 0; index < bytes.length; index += BASE64_ENCODING_CHUNK_BYTES) {
    binaryChunks.push(
      String.fromCharCode(...bytes.subarray(index, index + BASE64_ENCODING_CHUNK_BYTES)),
    );
  }

  return window.btoa(binaryChunks.join(""));
}

function decodeBase64Bytes(value) {
  try {
    const binaryString = window.atob(value);
    return Uint8Array.from(binaryString, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Encryption key must be valid base64.");
  }
}

function createDecryptionFailure(message) {
  return Object.assign(new Error(message), {
    code: "decryption-failed",
  });
}

function isDecryptionFailure(error) {
  return error?.code === "decryption-failed";
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
