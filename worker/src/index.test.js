import { afterEach, describe, expect, test, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { createWorker } from './index.js';

const baseEnv = {
  AWS_REGION: 'us-east-1',
  CHAT_BUCKET_NAME: 'woodwire-chat',
  CHAT_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat',
  PWA_ORIGIN: 'https://app.example.com',
  RATE_LIMIT_REQUESTS: '30',
  RATE_LIMIT_WINDOW_SECONDS: '60',
  STATUS_CACHE_TTL_SECONDS: '3',
  WOODWIRE_AUTH: 'super-secret',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Woodwire Worker', () => {
  test('returns a health check without authentication', async () => {
    const worker = createWorker();
    const response = await worker.fetch(
      new Request('https://worker.example.com/api/health'),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  test('rejects unauthenticated message requests', async () => {
    const worker = createWorker({
      createSqsClient: () => ({
        send: vi.fn(),
      }),
    });
    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text: 'Hello' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  test('enqueues a message when the request is authenticated', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'message-1' });
    const worker = createWorker({
      createSqsClient: () => ({
        send,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: ['attachments/a.txt'], text: 'Hello Woodwire' }),
        headers: {
          'content-type': 'application/json',
          'Origin': baseEnv.PWA_ORIGIN,
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(baseEnv.PWA_ORIGIN);
    expect(await response.json()).toEqual({
      conversationId: 'conversation-123',
      status: 'pending',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][0].input.MessageBody)).toMatchObject({
      schemaVersion: 1,
      attachments: ['attachments/a.txt'],
      conversationId: 'conversation-123',
      text: 'Hello Woodwire',
    });
  });

  test('returns validation errors for malformed message payloads', async () => {
    const worker = createWorker();
    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: 'not-an-array', text: '' }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "text" must be a non-empty string',
    });
  });

  test('rejects a message payload that exceeds the 256 KB SQS limit', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'message-1' });
    const worker = createWorker({
      createSqsClient: () => ({
        send,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    // Build a payload and incrementally increase text until it exceeds the limit
    // This ensures we test with an actual oversized payload
    const MAX_SQS_MESSAGE_BYTES = 262144;
    const basePayload = {
      schemaVersion: 1,
      conversationId: 'conversation-123',
      createdAt: '2026-06-30T12:00:00.000Z',
      attachments: [],
      text: '',
    };
    const baseSize = new TextEncoder().encode(JSON.stringify(basePayload)).byteLength;
    // Add enough text to exceed the limit
    const textLength = MAX_SQS_MESSAGE_BYTES - baseSize + 1000;
    const largeText = 'x'.repeat(textLength);

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text: largeText }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Message payload is too large',
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('accepts a message payload just under the 256 KB SQS limit', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'message-1' });
    const worker = createWorker({
      createSqsClient: () => ({
        send,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    // Build a payload just under the 256 KB limit
    const MAX_SQS_MESSAGE_BYTES = 262144;
    const basePayload = {
      schemaVersion: 1,
      conversationId: 'conversation-123',
      createdAt: '2026-06-30T12:00:00.000Z',
      attachments: [],
      text: '',
    };
    const baseSize = new TextEncoder().encode(JSON.stringify(basePayload)).byteLength;
    // Add text that keeps the total just under the limit
    const textLength = MAX_SQS_MESSAGE_BYTES - baseSize - 100;
    const text = 'x'.repeat(textLength);

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      conversationId: 'conversation-123',
      status: 'pending',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('rate limits repeated authenticated requests from the same IP', async () => {
    const worker = createWorker({
      createSqsClient: () => ({
        send: vi.fn().mockResolvedValue({}),
      }),
      now: vi
        .fn()
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_500),
    });
    const env = {
      ...baseEnv,
      RATE_LIMIT_REQUESTS: '1',
      RATE_LIMIT_WINDOW_SECONDS: '60',
    };
    const request = (body) =>
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify(body),
        headers: {
          'CF-Connecting-IP': '203.0.113.10',
          'content-type': 'application/json',
          'X-Woodwire-Auth': env.WOODWIRE_AUTH,
        },
        method: 'POST',
      });

    const firstResponse = await worker.fetch(
      request({ attachments: [], text: 'first' }),
      env,
      {},
    );
    const secondResponse = await worker.fetch(
      request({ attachments: [], text: 'second' }),
      env,
      {},
    );

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(429);
    expect(secondResponse.headers.get('Retry-After')).toBe('60');
  });

  test('returns conversation status and uses the edge cache', async () => {
    const s3Send = vi
      .fn()
      .mockResolvedValue({ Contents: [{ Key: 'outbox/conversation-123/response.md' }] });
    const cacheStore = new Map();
    const cache = {
      async match(request) {
        const cached = cacheStore.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request, response) {
        cacheStore.set(request.url, response.clone());
      },
    };
    const waitUntilPromises = [];
    const worker = createWorker({
      cache,
      createS3Client: () => ({
        send: s3Send,
      }),
    });
    const request = new Request('https://worker.example.com/api/status/conversation-123', {
      headers: {
        'Origin': baseEnv.PWA_ORIGIN,
        'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
      },
      method: 'GET',
    });

    const firstResponse = await worker.fetch(request, baseEnv, {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });
    await Promise.all(waitUntilPromises);
    const secondResponse = await worker.fetch(request, baseEnv, {});

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      cacheTtlSeconds: 3,
      conversationId: 'conversation-123',
      hasAudio: false,
      hasTranscript: true,
      status: 'complete',
    });
    expect(firstResponse.headers.get('CDN-Cache-Control')).toBe('max-age=3');
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      cacheTtlSeconds: 3,
      conversationId: 'conversation-123',
      hasAudio: false,
      hasTranscript: true,
      status: 'complete',
    });
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  test('detects processing status from the marker object', async () => {
    const worker = createWorker({
      createS3Client: () => ({
        send: vi.fn().mockResolvedValue({
          Contents: [{ Key: 'outbox/conversation-999/processing.json' }],
        }),
      }),
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/status/conversation-999', {
        headers: { 'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH },
        method: 'GET',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cacheTtlSeconds: 3,
      conversationId: 'conversation-999',
      hasAudio: false,
      hasTranscript: false,
      status: 'processing',
    });
  });

  test('generates a pre-signed upload URL with a scoped S3 key and content type', async () => {
    const signS3Url = vi.fn().mockResolvedValue('https://uploads.example.com/presigned-put');
    const worker = createWorker({
      createS3Client: () => ({
        send: vi.fn(),
      }),
      now: () => 1_719_758_400_000,
      signS3Url,
    });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('conversation-123')
      .mockReturnValueOnce('object-456');

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/upload-url', {
        body: JSON.stringify({
          contentType: 'image/png',
          filename: 'photo.png',
          sizeBytes: 1_024,
        }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      key: 'attachments/conversation-123/1719758400000-object-456.png',
      uploadUrl: 'https://uploads.example.com/presigned-put',
    });
    expect(signS3Url).toHaveBeenCalledTimes(1);
    expect(signS3Url.mock.calls[0][1]).toBeInstanceOf(PutObjectCommand);
    expect(signS3Url.mock.calls[0][1].input).toEqual({
      Bucket: baseEnv.CHAT_BUCKET_NAME,
      ContentType: 'image/png',
      Key: 'attachments/conversation-123/1719758400000-object-456.png',
    });
    expect(signS3Url.mock.calls[0][2]).toEqual({ expiresIn: 300 });
  });

  test('rejects oversized upload reservations before generating a URL', async () => {
    const signS3Url = vi.fn();
    const worker = createWorker({
      signS3Url,
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/upload-url', {
        body: JSON.stringify({
          contentType: 'audio/mpeg',
          filename: 'voice-note.mp3',
          sizeBytes: 26 * 1024 * 1024,
        }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Attachments must be 25 MB or smaller',
    });
    expect(signS3Url).not.toHaveBeenCalled();
  });

  test('rejects disallowed upload content types', async () => {
    const signS3Url = vi.fn();
    const worker = createWorker({
      signS3Url,
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/upload-url', {
        body: JSON.stringify({
          contentType: 'application/x-msdownload',
          filename: 'payload.exe',
        }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "contentType" is not allowed',
    });
    expect(signS3Url).not.toHaveBeenCalled();
  });

  test('returns a pre-signed download URL for an uploaded attachment', async () => {
    const signS3Url = vi.fn().mockResolvedValue('https://downloads.example.com/presigned-attachment');
    const worker = createWorker({
      createS3Client: () => ({
        send: vi.fn(),
      }),
      signS3Url,
    });

    const response = await worker.fetch(
      new Request(
        'https://worker.example.com/api/attachment?key=attachments%2Fconversation-123%2F1719758400000-object-456.png',
        {
          headers: {
            'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
          },
          method: 'GET',
        },
      ),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      downloadUrl: 'https://downloads.example.com/presigned-attachment',
      key: 'attachments/conversation-123/1719758400000-object-456.png',
    });
    expect(signS3Url).toHaveBeenCalledTimes(1);
    expect(signS3Url.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
    expect(signS3Url.mock.calls[0][1].input).toEqual({
      Bucket: baseEnv.CHAT_BUCKET_NAME,
      Key: 'attachments/conversation-123/1719758400000-object-456.png',
    });
    expect(signS3Url.mock.calls[0][2]).toEqual({ expiresIn: 900 });
  });

  test('rejects invalid attachment keys', async () => {
    const signS3Url = vi.fn();
    const worker = createWorker({
      signS3Url,
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/attachment?key=../../private.txt', {
        headers: {
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'GET',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid attachment key',
    });
    expect(signS3Url).not.toHaveBeenCalled();
  });

  test('returns transcript text and a pre-signed audio URL for a completed response', async () => {
    const signS3Url = vi.fn().mockResolvedValue('https://downloads.example.com/presigned-get');
    const s3Send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'outbox/conversation-123/1719758400000-response.md' },
          { Key: 'outbox/conversation-123/1719758400000-response.mp3' },
        ],
      })
      .mockResolvedValueOnce({
        Body: {
          transformToString: vi.fn().mockResolvedValue('Transcript reply'),
        },
      });
    const worker = createWorker({
      createS3Client: () => ({
        send: s3Send,
      }),
      signS3Url,
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/response/conversation-123', {
        headers: {
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'GET',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      audioUrl: 'https://downloads.example.com/presigned-get',
      transcript: 'Transcript reply',
    });
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(signS3Url).toHaveBeenCalledTimes(1);
    expect(signS3Url.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
    expect(signS3Url.mock.calls[0][1].input).toEqual({
      Bucket: baseEnv.CHAT_BUCKET_NAME,
      Key: 'outbox/conversation-123/1719758400000-response.mp3',
    });
    expect(signS3Url.mock.calls[0][2]).toEqual({ expiresIn: 900 });
  });

  test('returns only transcript text when no audio response exists', async () => {
    const s3Send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'outbox/conversation-555/1719758400000-response.md' }],
      })
      .mockResolvedValueOnce({
        Body: {
          transformToString: vi.fn().mockResolvedValue('Transcript only'),
        },
      });
    const worker = createWorker({
      createS3Client: () => ({
        send: s3Send,
      }),
      signS3Url: vi.fn(),
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/response/conversation-555', {
        headers: {
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'GET',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      audioUrl: null,
      transcript: 'Transcript only',
    });
  });

  test('returns only a pre-signed audio URL when no transcript exists', async () => {
    const signS3Url = vi.fn().mockResolvedValue('https://downloads.example.com/presigned-audio');
    const s3Send = vi.fn().mockResolvedValue({
      Contents: [{ Key: 'outbox/conversation-777/1719758400000-response.mp3' }],
    });
    const worker = createWorker({
      createS3Client: () => ({
        send: s3Send,
      }),
      signS3Url,
    });

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/response/conversation-777', {
        headers: {
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'GET',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      audioUrl: 'https://downloads.example.com/presigned-audio',
      transcript: null,
    });
  });

  test('rejects browser requests from non-PWA origins', async () => {
    const worker = createWorker();
    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text: 'Hello' }),
        headers: {
          'Origin': 'https://evil.example.com',
          'content-type': 'application/json',
          'X-Woodwire-Auth': baseEnv.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });
});
