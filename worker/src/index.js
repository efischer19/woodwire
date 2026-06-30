import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const AUTH_HEADER = 'X-Woodwire-Auth';
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const RATE_LIMIT_STORE = new Map();
const STATUS_PROCESSING_KEY = 'processing.json';
const STATUS_CACHE_TTL_SECONDS = 3;
const STATUS_CACHE_MIN_SECONDS = 2;
const STATUS_CACHE_MAX_SECONDS = 5;
const DEFAULT_RATE_LIMIT_REQUESTS = 30;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

export function createWorker(dependencies = {}) {
  return {
    async fetch(request, env, context) {
      return handleRequest(request, env, context, dependencies);
    },
  };
}

export async function handleRequest(request, env, context = {}, dependencies = {}) {
  const url = new URL(request.url);
  const originCheck = validateOrigin(request, env);

  if (!originCheck.allowed) {
    return createResponse(request, env, 403, { error: 'Forbidden' });
  }

  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    return createResponse(request, env, 204, null, {
      'Access-Control-Allow-Headers': `Content-Type, ${AUTH_HEADER}`,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
  }

  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') {
      return methodNotAllowed(request, env, 'GET, OPTIONS');
    }

    return createResponse(request, env, 200, { status: 'ok' });
  }

  if (!url.pathname.startsWith('/api/')) {
    return createResponse(request, env, 404, { error: 'Not Found' });
  }

  if (!(await isAuthorized(request, env))) {
    return createResponse(request, env, 401, { error: 'Unauthorized' });
  }

  const rateLimit = enforceRateLimit(request, env, dependencies.now ?? Date.now);

  if (!rateLimit.allowed) {
    return createResponse(request, env, 429, { error: 'Too Many Requests' }, {
      'Retry-After': String(rateLimit.retryAfterSeconds),
    });
  }

  if (url.pathname === '/api/message') {
    if (request.method !== 'POST') {
      return methodNotAllowed(request, env, 'POST, OPTIONS');
    }

    return handleMessageRequest(request, env, dependencies);
  }

  if (url.pathname === '/api/upload-url') {
    if (request.method !== 'POST') {
      return methodNotAllowed(request, env, 'POST, OPTIONS');
    }

    return createResponse(request, env, 501, {
      error: 'Not Implemented',
      message: 'Attachment upload URL generation is implemented in ticket 07.',
    });
  }

  if (url.pathname.startsWith('/api/status/')) {
    if (request.method !== 'GET') {
      return methodNotAllowed(request, env, 'GET, OPTIONS');
    }

    return handleStatusRequest(request, env, context, dependencies);
  }

  if (url.pathname.startsWith('/api/response/')) {
    if (request.method !== 'GET') {
      return methodNotAllowed(request, env, 'GET, OPTIONS');
    }

    return createResponse(request, env, 501, {
      error: 'Not Implemented',
      message: 'Response retrieval is implemented in ticket 07.',
    });
  }

  return createResponse(request, env, 404, { error: 'Not Found' });
}

async function handleMessageRequest(request, env, dependencies) {
  let body;

  try {
    body = await readJson(request);
  } catch {
    return createResponse(request, env, 400, { error: 'Invalid request body' });
  }

  const validationError = validateMessagePayload(body);

  if (validationError) {
    return createResponse(request, env, 400, { error: validationError });
  }

  if (!env.CHAT_QUEUE_URL) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }

  const conversationId = crypto.randomUUID();
  const payload = {
    attachments: body.attachments,
    conversationId,
    createdAt: new Date().toISOString(),
    text: body.text,
  };
  const sqsClient =
    dependencies.createSqsClient?.(env) ??
    new SQSClient({
      credentials: buildAwsCredentials(env),
      region: env.AWS_REGION ?? 'us-east-1',
    });

  try {
    await sqsClient.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify(payload),
        QueueUrl: env.CHAT_QUEUE_URL,
      }),
    );
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }

  return createResponse(request, env, 202, {
    conversationId,
    status: 'pending',
  });
}

async function handleStatusRequest(request, env, context, dependencies) {
  const pathname = new URL(request.url).pathname;
  const conversationId = pathname.slice('/api/status/'.length);

  if (!isValidConversationId(conversationId)) {
    return createResponse(request, env, 400, { error: 'Invalid conversation ID' });
  }

  if (!env.CHAT_BUCKET_NAME) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }

  const cache = dependencies.cache ?? globalThis.caches?.default;
  const ttlSeconds = getStatusCacheTtl(env);
  const cacheKey = new Request(request.url, { method: 'GET' });

  if (cache) {
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      return cachedResponse;
    }
  }

  const prefix = `outbox/${conversationId}/`;
  const s3Client =
    dependencies.createS3Client?.(env) ??
    new S3Client({
      credentials: buildAwsCredentials(env),
      region: env.AWS_REGION ?? 'us-east-1',
    });

  let listResponse;

  try {
    listResponse = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: env.CHAT_BUCKET_NAME,
        MaxKeys: 25,
        Prefix: prefix,
      }),
    );
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }

  const status = deriveConversationStatus(prefix, listResponse.Contents ?? []);
  const response = createResponse(
    request,
    env,
    200,
    {
      cacheTtlSeconds: ttlSeconds,
      conversationId,
      status,
    },
    {
      'Cache-Control': `max-age=0, s-maxage=${ttlSeconds}`,
      'CDN-Cache-Control': `max-age=${ttlSeconds}`,
    },
  );

  if (cache) {
    const waitUntil = context?.waitUntil?.bind(context);

    if (waitUntil) {
      waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      await cache.put(cacheKey, response.clone());
    }
  }

  return response;
}

function validateMessagePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }

  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return 'Field "text" must be a non-empty string';
  }

  if (!Array.isArray(body.attachments)) {
    return 'Field "attachments" must be an array';
  }

  if (!body.attachments.every((attachment) => typeof attachment === 'string' && attachment.trim() !== '')) {
    return 'Each attachment must be a non-empty string';
  }

  return null;
}

function deriveConversationStatus(prefix, objects) {
  const keys = objects
    .map((object) => object?.Key)
    .filter((key) => typeof key === 'string');
  const processingKey = `${prefix}${STATUS_PROCESSING_KEY}`;
  const hasCompleteObject = keys.some((key) => key !== processingKey);

  if (hasCompleteObject) {
    return 'complete';
  }

  if (keys.includes(processingKey)) {
    return 'processing';
  }

  return 'pending';
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('Invalid content type');
  }

  return request.json();
}

function validateOrigin(request, env) {
  const origin = request.headers.get('Origin');

  if (!origin || !env.PWA_ORIGIN) {
    return { allowed: true };
  }

  return { allowed: origin === env.PWA_ORIGIN };
}

async function isAuthorized(request, env) {
  const expectedSecret = env.WOODWIRE_AUTH;
  const providedSecret = request.headers.get(AUTH_HEADER) ?? '';

  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0) {
    return false;
  }

  return secureEquals(providedSecret, expectedSecret);
}

async function secureEquals(left, right) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

function enforceRateLimit(request, env, now) {
  const limit = parsePositiveInt(env.RATE_LIMIT_REQUESTS, DEFAULT_RATE_LIMIT_REQUESTS);
  const windowSeconds = parsePositiveInt(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ip = getClientIp(request);
  const currentTime = now();
  const windowStartedAt = currentTime - windowSeconds * 1000;
  const existingEntries = RATE_LIMIT_STORE.get(ip) ?? [];
  const activeEntries = existingEntries.filter((entry) => entry > windowStartedAt);

  if (activeEntries.length >= limit) {
    const oldestEntry = activeEntries[0] ?? currentTime;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestEntry + windowSeconds * 1000 - currentTime) / 1000),
    );

    RATE_LIMIT_STORE.set(ip, activeEntries);

    return { allowed: false, retryAfterSeconds };
  }

  activeEntries.push(currentTime);
  RATE_LIMIT_STORE.set(ip, activeEntries);

  return { allowed: true };
}

function getClientIp(request) {
  const forwardedFor = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For');

  if (!forwardedFor) {
    return 'unknown';
  }

  return forwardedFor.split(',')[0].trim();
}

function isValidConversationId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function getStatusCacheTtl(env) {
  const rawTtl = parsePositiveInt(env.STATUS_CACHE_TTL_SECONDS, STATUS_CACHE_TTL_SECONDS);

  return Math.min(STATUS_CACHE_MAX_SECONDS, Math.max(STATUS_CACHE_MIN_SECONDS, rawTtl));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function buildAwsCredentials(env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    return undefined;
  }

  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

function methodNotAllowed(request, env, allowHeader) {
  return createResponse(request, env, 405, { error: 'Method Not Allowed' }, { Allow: allowHeader });
}

function createResponse(request, env, status, body, extraHeaders = {}) {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
    ...extraHeaders,
  });
  const origin = request.headers.get('Origin');

  if (origin && env.PWA_ORIGIN && origin === env.PWA_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(body === null ? null : JSON.stringify(body), {
    headers,
    status,
  });
}

export default createWorker();
