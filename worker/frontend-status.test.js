import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

class FakeTextNode {
  constructor(text = '') {
    this.nodeType = 3;
    this.parentNode = null;
    this.textContent = text;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.parentNode = null;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.textContent = '';
    this.classList = {
      contains: (className) => this.className.split(/\s+/u).filter(Boolean).includes(className),
      toggle: (className, force) => {
        const classNames = new Set(this.className.split(/\s+/u).filter(Boolean));

        if (force === undefined ? !classNames.has(className) : force) {
          classNames.add(className);
        } else {
          classNames.delete(className);
        }

        this.className = Array.from(classNames).join(' ');
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeTextNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }

    this.scrollHeight = this.children.length;
    this.scrollTop = this.scrollHeight;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];

    const visit = (node) => {
      if (!(node instanceof FakeElement)) {
        return;
      }

      if (matchesSelector(node, selector)) {
        matches.push(node);
      }

      for (const child of node.children) {
        visit(child);
      }
    };

    visit(this);
    return matches;
  }

  set innerHTML(value) {
    if (value === '') {
      this.children = [];
    }
  }

  get hidden() {
    return this.attributes.has('hidden');
  }

  set hidden(value) {
    if (value) {
      this.attributes.set('hidden', '');
      return;
    }

    this.attributes.delete('hidden');
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    if (name === 'hidden') {
      this.attributes.set(name, String(value));
      return;
    }

    this.attributes.set(name, String(value));
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }

  const attributeMatches = selector.match(/\[data-[^\]]+\]/gu) ?? [];

  if (!attributeMatches.length) {
    return false;
  }

  return attributeMatches.every((attributeSelector) => {
    const match = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/u.exec(attributeSelector);

    if (!match) {
      return false;
    }

    const key = match[1].replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
    const value = element.dataset[key];

    if (match[2] === undefined) {
      return value !== undefined;
    }

    return value === match[2];
  });
}

function createDocument() {
  return {
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createTextNode(text) {
      return new FakeTextNode(text);
    },
  };
}

function createLocalStorage() {
  const store = new Map();

  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

function loadApp(fetchImplementation) {
  const sourcePath = path.resolve(import.meta.dirname, '../src/scripts/app.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const document = createDocument();
  const localStorage = createLocalStorage();
  const navigator = { onLine: true };
  const window = {
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    clearTimeout() {},
    document,
    location: { origin: 'https://pwa.example.com' },
    navigator,
    setTimeout() {
      return 1;
    },
  };

  const context = {
    Array,
    Blob,
    Boolean,
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Request,
    String,
    Response,
    Set,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    crypto: {
      randomUUID: () => 'generated-local-id',
    },
    document,
    fetch: fetchImplementation,
    localStorage,
    navigator,
    window,
  };

  context.globalThis = context;
  window.crypto = context.crypto;
  window.localStorage = localStorage;

  vm.runInNewContext(
    `${source}
globalThis.__appExports = {
  appendMessage,
  getStoredMessages,
  pollConversation,
  renderComposerDrawer,
  syncVisibleConversation,
  trackPendingConversation,
  STORAGE_KEYS,
};`,
    context,
    { filename: sourcePath },
  );

  return {
    exports: context.__appExports,
    localStorage,
  };
}

describe('frontend threaded status handling', () => {
  test('reflects hidden property changes through attribute helpers', () => {
    const element = new FakeElement('section');

    expect(element.hidden).toBe(false);
    expect(element.getAttribute('hidden')).toBeNull();
    expect(element.hasAttribute('hidden')).toBe(false);

    element.hidden = true;

    expect(element.hidden).toBe(true);
    expect(element.getAttribute('hidden')).toBe('');
    expect(element.hasAttribute('hidden')).toBe(true);

    element.removeAttribute('hidden');

    expect(element.hidden).toBe(false);
    expect(element.getAttribute('hidden')).toBeNull();
    expect(element.hasAttribute('hidden')).toBe(false);

    element.setAttribute('hidden', 'until-found');

    expect(element.hidden).toBe(true);
    expect(element.getAttribute('hidden')).toBe('until-found');
    expect(element.hasAttribute('hidden')).toBe(true);
  });

  test('re-renders only the selected conversation when switching threads', () => {
    const { exports, localStorage } = loadApp(vi.fn());
    localStorage.setItem(exports.STORAGE_KEYS.activeConversationId, 'conversation-a');

    const elements = {
      messageHistory: new FakeElement('section'),
      screenReaderStatus: new FakeElement('div'),
    };

    exports.appendMessage(elements, {
      author: 'You',
      conversationId: 'conversation-a',
      localId: 'user-a',
      status: 'Reply received',
      text: 'Thread A',
      timestamp: '2026-07-24T11:00:00.000Z',
      variant: 'user',
    });
    exports.appendMessage(elements, {
      author: 'AI',
      conversationId: 'conversation-a',
      responseFor: 'user-a',
      responseId: 'response-a',
      text: 'Reply A',
      timestamp: '2026-07-24T11:00:05.000Z',
      variant: 'assistant',
    });
    exports.appendMessage(elements, {
      author: 'You',
      conversationId: 'conversation-b',
      localId: 'user-b',
      status: 'Reply received',
      text: 'Thread B',
      timestamp: '2026-07-24T11:01:00.000Z',
      variant: 'user',
    });
    exports.appendMessage(elements, {
      author: 'AI',
      conversationId: 'conversation-b',
      responseFor: 'user-b',
      responseId: 'response-b',
      text: 'Reply B',
      timestamp: '2026-07-24T11:01:05.000Z',
      variant: 'assistant',
    });

    expect(elements.messageHistory.querySelectorAll('.message').length).toBe(2);
    expect(elements.messageHistory.querySelectorAll('[data-conversation-id="conversation-a"]').length).toBe(2);

    localStorage.setItem(exports.STORAGE_KEYS.activeConversationId, 'conversation-b');
    exports.syncVisibleConversation(elements, 'conversation-b');

    expect(elements.messageHistory.querySelectorAll('.message').length).toBe(2);
    expect(elements.messageHistory.querySelectorAll('[data-conversation-id="conversation-a"]').length).toBe(0);
    expect(elements.messageHistory.querySelectorAll('[data-conversation-id="conversation-b"]').length).toBe(2);
  });

  test('shows only the welcome message for an empty selected conversation', () => {
    const { exports, localStorage } = loadApp(vi.fn());
    localStorage.setItem(exports.STORAGE_KEYS.activeConversationId, 'conversation-a');

    const elements = {
      messageHistory: new FakeElement('section'),
      screenReaderStatus: new FakeElement('div'),
    };

    exports.appendMessage(elements, {
      author: 'You',
      conversationId: 'conversation-a',
      localId: 'user-a',
      status: 'Reply received',
      text: 'Thread A',
      timestamp: '2026-07-24T11:00:00.000Z',
      variant: 'user',
    });

    localStorage.setItem(exports.STORAGE_KEYS.activeConversationId, 'conversation-empty');
    exports.syncVisibleConversation(elements, 'conversation-empty');

    expect(elements.messageHistory.querySelectorAll('.message').length).toBe(1);
    expect(elements.messageHistory.querySelectorAll('.message-assistant').length).toBe(1);
    expect(elements.messageHistory.querySelectorAll('[data-conversation-id]').length).toBe(0);
    expect(elements.messageHistory.children[0].children[0].children[0].textContent).toContain(
      'Hello. Save your Worker connection details',
    );
  });

  test('starts the composer drawer hidden and shows it when expanded', () => {
    const { exports } = loadApp(vi.fn());
    const elements = {
      attachmentButton: new FakeElement('button'),
      attachmentToggleBadge: new FakeElement('span'),
      composerDrawer: new FakeElement('section'),
    };
    const state = {
      composerAttachments: [],
      isComposerDrawerExpanded: false,
      voiceMemo: {
        isRecording: false,
        previewUrl: '',
      },
    };

    elements.composerDrawer.className = 'composer-drawer';
    elements.composerDrawer.hidden = true;

    exports.renderComposerDrawer(elements, state);

    expect(elements.composerDrawer.hidden).toBe(true);
    expect(elements.composerDrawer.className).toBe('composer-drawer');
    expect(elements.attachmentButton.getAttribute('aria-expanded')).toBe('false');

    state.isComposerDrawerExpanded = true;
    exports.renderComposerDrawer(elements, state);

    expect(elements.composerDrawer.hidden).toBe(false);
    expect(elements.composerDrawer.className).toBe('composer-drawer');
    expect(elements.attachmentButton.classList.contains('is-active')).toBe(true);
    expect(elements.attachmentButton.getAttribute('aria-expanded')).toBe('true');
  });

  test('keeps a follow-up message pending until a newer response is available', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cacheTtlSeconds: 3,
            conversationId: 'conversation-123',
            hasAudio: false,
            hasTranscript: true,
            latestResponseId: 'response-1',
            status: 'complete',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cacheTtlSeconds: 3,
            conversationId: 'conversation-123',
            hasAudio: false,
            hasTranscript: false,
            latestResponseId: 'response-1',
            status: 'processing',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cacheTtlSeconds: 3,
            conversationId: 'conversation-123',
            hasAudio: false,
            hasTranscript: true,
            latestResponseId: 'response-2',
            status: 'complete',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audioUrl: null,
            responseId: 'response-2',
            transcriptUrl: null,
          }),
          { status: 200 },
        ),
      );

    const { exports, localStorage } = loadApp(fetch);
    localStorage.setItem(exports.STORAGE_KEYS.auth, 'test-auth');
    localStorage.setItem(exports.STORAGE_KEYS.apiBase, 'https://worker.example.com');
    localStorage.setItem(exports.STORAGE_KEYS.activeConversationId, 'conversation-123');

    const elements = {
      messageHistory: new FakeElement('section'),
      screenReaderStatus: new FakeElement('div'),
    };
    const state = {
      pendingConversations: new Map(),
    };

    exports.appendMessage(elements, {
      author: 'You',
      conversationId: 'conversation-123',
      localId: 'user-1',
      status: 'Reply received',
      text: 'First message',
      timestamp: '2026-07-24T11:00:00.000Z',
      variant: 'user',
    });
    exports.appendMessage(elements, {
      author: 'AI',
      conversationId: 'conversation-123',
      responseFor: 'user-1',
      responseId: 'response-1',
      text: 'First reply',
      timestamp: '2026-07-24T11:00:05.000Z',
      variant: 'assistant',
    });
    exports.appendMessage(elements, {
      author: 'You',
      conversationId: 'conversation-123',
      localId: 'user-2',
      status: 'Sent · waiting for reply',
      text: 'Follow-up message',
      timestamp: '2026-07-24T11:01:00.000Z',
      variant: 'user',
    });

    const pendingConversation = {
      conversationId: 'conversation-123',
      localId: 'user-2',
      responseId: 'response-1',
      startedAt: Date.now(),
    };
    exports.trackPendingConversation(state, pendingConversation);

    await exports.pollConversation(pendingConversation, elements, state);
    expect(
      elements.messageHistory.querySelector('[data-local-id="user-2"]').querySelector('.message-status')
        .textContent,
    ).toBe('Waiting for the bot…');
    expect(state.pendingConversations.size).toBe(1);
    expect(elements.messageHistory.querySelectorAll('[data-response-id]').length).toBe(1);

    await exports.pollConversation(pendingConversation, elements, state);
    expect(
      elements.messageHistory.querySelector('[data-local-id="user-2"]').querySelector('.message-status')
        .textContent,
    ).toBe('Bot is replying…');
    expect(state.pendingConversations.size).toBe(1);

    await exports.pollConversation(pendingConversation, elements, state);
    expect(
      elements.messageHistory.querySelector('[data-local-id="user-2"]').querySelector('.message-status')
        .textContent,
    ).toBe('Reply received');
    expect(state.pendingConversations.size).toBe(0);
    expect(elements.messageHistory.querySelectorAll('[data-response-id]').length).toBe(2);
    expect(exports.getStoredMessages().filter((message) => message.role === 'ai')).toEqual([
      expect.objectContaining({ id: 'response-1', responseFor: 'user-1' }),
      expect.objectContaining({ id: 'response-2', responseFor: 'user-2' }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
