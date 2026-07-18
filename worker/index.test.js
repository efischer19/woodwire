import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWorker, MAX_SQS_MESSAGE_BYTES } from './index.js';

const baseEnv = {
  AWS_ACCESS_KEY_ID: 'test-access-key-id',
  AWS_REGION: 'us-east-1',
  AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
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
    const worker = createWorker();
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
    const mockFetch = vi.fn().mockResolvedValue(new Response('<SendMessageResponse />', { status: 200 }));
    const worker = createWorker({
      createAwsClient: () => ({
        fetch: mockFetch,
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
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(baseEnv.CHAT_QUEUE_URL);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    });
    const sentBody = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(sentBody.get('Action')).toBe('SendMessage');
    expect(sentBody.get('Version')).toBe('2012-11-05');
    expect(JSON.parse(sentBody.get('MessageBody'))).toMatchObject({
      schemaVersion: 1,
      attachments: ['attachments/a.txt'],
      conversationId: 'conversation-123',
      text: 'Hello Woodwire',
    });
  });

  test('preserves schema version 2 for encrypted message payloads', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('<SendMessageResponse />', { status: 200 }));
    const worker = createWorker({
      createAwsClient: () => ({
        fetch: mockFetch,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], schemaVersion: 2, text: 'encrypted-ciphertext' }),
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
    const sentBody = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(JSON.parse(sentBody.get('MessageBody'))).toMatchObject({
      schemaVersion: 2,
      text: 'encrypted-ciphertext',
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
    const mockFetch = vi.fn().mockResolvedValue(new Response('<SendMessageResponse />', { status: 200 }));
    const worker = createWorker({
      createAwsClient: () => ({
        fetch: mockFetch,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    // Build a payload and incrementally increase text until it exceeds the limit
    // This ensures we test with an actual oversized payload
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
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('accepts a message payload just under the 256 KB SQS limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('<SendMessageResponse />', { status: 200 }));
    const worker = createWorker({
      createAwsClient: () => ({
        fetch: mockFetch,
      }),
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('conversation-123');

    // Build a payload just under the 256 KB limit
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
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('returns internal server error when AWS credentials are missing', async () => {
    const worker = createWorker();
    const envWithoutCredentials = {
      ...baseEnv,
    };
    delete envWithoutCredentials.AWS_ACCESS_KEY_ID;
    delete envWithoutCredentials.AWS_SECRET_ACCESS_KEY;

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text: 'Hello' }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': envWithoutCredentials.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      envWithoutCredentials,
      {},
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });

  test('returns internal server error when only one AWS credential is configured', async () => {
    const worker = createWorker();
    const envMissingSecret = {
      ...baseEnv,
    };
    delete envMissingSecret.AWS_SECRET_ACCESS_KEY;

    const response = await worker.fetch(
      new Request('https://worker.example.com/api/message', {
        body: JSON.stringify({ attachments: [], text: 'Hello' }),
        headers: {
          'content-type': 'application/json',
          'X-Woodwire-Auth': envMissingSecret.WOODWIRE_AUTH,
        },
        method: 'POST',
      }),
      envMissingSecret,
      {},
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });

  test('rate limits repeated authenticated requests from the same IP', async () => {
    const worker = createWorker({
      createAwsClient: () => ({
        fetch: vi.fn().mockResolvedValue(new Response('<SendMessageResponse />', { status: 200 })),
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
    const fetchS3List = vi.fn().mockResolvedValue(
      new Response(
        '<ListBucketResult><Contents><Key>outbox/conversation-123/response.md</Key></Contents></ListBucketResult>',
        { status: 200 },
      ),
    );
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
      createAwsClient: () => ({}),
      fetchS3List,
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
    expect(fetchS3List).toHaveBeenCalledTimes(1);
  });

  test('detects processing status from the marker object', async () => {
    const worker = createWorker({
      createAwsClient: () => ({}),
      fetchS3List: vi.fn().mockResolvedValue(
        new Response(
          '<ListBucketResult><Contents><Key>outbox/conversation-999/processing.json</Key></Contents></ListBucketResult>',
          { status: 200 },
        ),
      ),
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
    const signS3Request = vi.fn().mockResolvedValue({ url: 'https://uploads.example.com/presigned-put' });
    const worker = createWorker({
      createAwsClient: () => ({}),
      now: () => 1_719_758_400_000,
      signS3Request,
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
    expect(signS3Request).toHaveBeenCalledTimes(1);
    expect(signS3Request.mock.calls[0][1]).toBe(
      'https://woodwire-chat.s3.amazonaws.com/attachments/conversation-123/1719758400000-object-456.png',
    );
    expect(signS3Request.mock.calls[0][2]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      aws: {
        expires: 300,
        region: 'us-east-1',
        service: 's3',
        signQuery: true,
      },
    });
  });

  test('rejects oversized upload reservations before generating a URL', async () => {
    const signS3Request = vi.fn();
    const worker = createWorker({
      signS3Request,
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
    expect(signS3Request).not.toHaveBeenCalled();
  });

  test('rejects disallowed upload content types', async () => {
    const signS3Request = vi.fn();
    const worker = createWorker({
      signS3Request,
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
    expect(signS3Request).not.toHaveBeenCalled();
  });

  test('returns a pre-signed download URL for an uploaded attachment', async () => {
    const signS3Request = vi.fn().mockResolvedValue({
      url: 'https://downloads.example.com/presigned-attachment',
    });
    const worker = createWorker({
      createAwsClient: () => ({}),
      signS3Request,
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
    expect(signS3Request).toHaveBeenCalledTimes(1);
    expect(signS3Request.mock.calls[0][1]).toBe(
      'https://woodwire-chat.s3.amazonaws.com/attachments/conversation-123/1719758400000-object-456.png',
    );
    expect(signS3Request.mock.calls[0][2]).toMatchObject({
      method: 'GET',
      aws: {
        expires: 900,
        region: 'us-east-1',
        service: 's3',
        signQuery: true,
      },
    });
  });

  test('rejects invalid attachment keys', async () => {
    const signS3Request = vi.fn();
    const worker = createWorker({
      signS3Request,
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
    expect(signS3Request).not.toHaveBeenCalled();
  });

  test('returns pre-signed transcript and audio URLs for a completed response', async () => {
    const signS3Request = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://downloads.example.com/presigned-audio' })
      .mockResolvedValueOnce({ url: 'https://downloads.example.com/presigned-transcript' });
    const fetchS3List = vi.fn().mockResolvedValue(
      new Response(
        '<ListBucketResult><Contents><Key>outbox/conversation-123/1719758400000-response.md</Key></Contents><Contents><Key>outbox/conversation-123/1719758400000-response.mp3</Key></Contents></ListBucketResult>',
        { status: 200 },
      ),
    );
    const worker = createWorker({
      createAwsClient: () => ({}),
      fetchS3List,
      signS3Request,
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
      audioUrl: 'https://downloads.example.com/presigned-audio',
      transcriptUrl: 'https://downloads.example.com/presigned-transcript',
    });
    expect(fetchS3List).toHaveBeenCalledTimes(1);
    expect(signS3Request).toHaveBeenCalledTimes(2);
    expect(signS3Request.mock.calls[0][1]).toBe(
      'https://woodwire-chat.s3.amazonaws.com/outbox/conversation-123/1719758400000-response.mp3',
    );
    expect(signS3Request.mock.calls[0][2]).toMatchObject({
      method: 'GET',
      aws: { expires: 900, region: 'us-east-1', service: 's3', signQuery: true },
    });
    expect(signS3Request.mock.calls[1][1]).toBe(
      'https://woodwire-chat.s3.amazonaws.com/outbox/conversation-123/1719758400000-response.md',
    );
  });

  test('returns only a pre-signed transcript URL when no audio response exists', async () => {
    const signS3Request = vi
      .fn()
      .mockResolvedValue({ url: 'https://downloads.example.com/presigned-transcript' });
    const fetchS3List = vi.fn().mockResolvedValue(
      new Response(
        '<ListBucketResult><Contents><Key>outbox/conversation-555/1719758400000-response.md</Key></Contents></ListBucketResult>',
        { status: 200 },
      ),
    );
    const worker = createWorker({
      createAwsClient: () => ({}),
      fetchS3List,
      signS3Request,
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
      transcriptUrl: 'https://downloads.example.com/presigned-transcript',
    });
  });

  test('returns only a pre-signed audio URL when no transcript exists', async () => {
    const signS3Request = vi.fn().mockResolvedValue({ url: 'https://downloads.example.com/presigned-audio' });
    const fetchS3List = vi.fn().mockResolvedValue(
      new Response(
        '<ListBucketResult><Contents><Key>outbox/conversation-777/1719758400000-response.mp3</Key></Contents></ListBucketResult>',
        { status: 200 },
      ),
    );
    const worker = createWorker({
      createAwsClient: () => ({}),
      fetchS3List,
      signS3Request,
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
      transcriptUrl: null,
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

  test('proxies GET requests for non-API paths to the origin', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('<!DOCTYPE html><html></html>', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    
    const worker = createWorker();
    const request = new Request('https://worker.example.com/index.html');
    const response = await worker.fetch(request, baseEnv, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!DOCTYPE html><html></html>');
    expect(mockFetch).toHaveBeenCalledWith(request);
  });

  test('returns 404 for non-GET requests to non-API paths', async () => {
    const worker = createWorker();
    const response = await worker.fetch(
      new Request('https://worker.example.com/some-resource', {
        method: 'POST',
      }),
      baseEnv,
      {},
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  test('proxies GET requests for CSS and JS assets to the origin', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('body { margin: 0; }', { status: 200, headers: { 'Content-Type': 'text/css' } }));
    vi.stubGlobal('fetch', mockFetch);
    
    const worker = createWorker();
    const request = new Request('https://worker.example.com/styles.css');
    const response = await worker.fetch(request, baseEnv, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('body { margin: 0; }');
    expect(mockFetch).toHaveBeenCalledWith(request);
  });
});
