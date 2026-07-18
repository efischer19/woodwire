import { AwsClient } from './aws4fetch.js';

const AUTH_HEADER = 'X-Woodwire-Auth';
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const RATE_LIMIT_STORE = new Map();
const STATUS_PROCESSING_KEY = 'processing.json';
// Upload URLs are short-lived because they are intended for immediate, single-object PUTs.
const UPLOAD_URL_EXPIRY_SECONDS = 5 * 60;
// Download URLs allow a slightly longer window to accommodate slower client downloads.
const DOWNLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// SQS enforces a 256 KB maximum message body size
export const MAX_SQS_MESSAGE_BYTES = 262144;
const STATUS_CACHE_TTL_SECONDS = 3;
const STATUS_CACHE_MIN_SECONDS = 2;
const STATUS_CACHE_MAX_SECONDS = 5;
const DEFAULT_RATE_LIMIT_REQUESTS = 30;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const ALLOWED_CONTENT_TYPE_PREFIXES = ['audio/', 'image/', 'text/'];
const ALLOWED_CONTENT_TYPES = new Set(['application/pdf']);
const FILENAME_EXTENSION_PATTERN = /\.([a-z0-9]{1,16})$/i;
const AUDIO_RESPONSE_EXTENSION = '.mp3';
const TRANSCRIPT_RESPONSE_EXTENSION = '.md';
const DEFAULT_EXTENSION_BY_CONTENT_TYPE = {
  'application/pdf': '.pdf',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
};
const XML_ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

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
    if (request.method === 'GET') {
      return fetch(request);
    }
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

    return handleUploadUrlRequest(request, env, dependencies);
  }

  if (url.pathname === '/api/attachment') {
    if (request.method !== 'GET') {
      return methodNotAllowed(request, env, 'GET, OPTIONS');
    }

    return handleAttachmentRequest(request, env, dependencies);
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

    return handleResponseRequest(request, env, dependencies);
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
  const awsConfigError = ensureAwsCredentialsConfigured(request, env);

  if (awsConfigError) {
    return awsConfigError;
  }

  const conversationId = crypto.randomUUID();
  const schemaVersion = getMessageSchemaVersion(body.schemaVersion);
  const payload = {
    schemaVersion,
    attachments: body.attachments,
    conversationId,
    createdAt: new Date().toISOString(),
    text: body.text,
  };

  const payloadString = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadString).byteLength;

  if (payloadBytes > MAX_SQS_MESSAGE_BYTES) {
    return createResponse(request, env, 413, { error: 'Message payload is too large' });
  }

  try {
    const awsClient = createAwsClient(env, dependencies);
    const response = await awsClient.fetch(env.CHAT_QUEUE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams({
        Action: 'SendMessage',
        MessageBody: payloadString,
        Version: '2012-11-05',
      }).toString(),
      aws: {
        region: env.AWS_REGION ?? 'us-east-1',
        service: 'sqs',
      },
    });

    if (!response.ok) {
      throw new Error(`SQS send failed with status ${response.status}`);
    }
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
  const awsConfigError = ensureAwsCredentialsConfigured(request, env);

  if (awsConfigError) {
    return awsConfigError;
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
  const region = env.AWS_REGION ?? 'us-east-1';

  let responseFiles;

  try {
    const awsClient = createAwsClient(env, dependencies);
    const objects = await listS3Objects(
      awsClient,
      env.CHAT_BUCKET_NAME,
      prefix,
      25,
      region,
      dependencies,
    );
    responseFiles = describeResponseFiles(prefix, objects);
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }
  const response = createResponse(
    request,
    env,
    200,
    {
      cacheTtlSeconds: ttlSeconds,
      conversationId,
      hasAudio: Boolean(responseFiles.audioKey),
      hasTranscript: Boolean(responseFiles.transcriptKey),
      status: responseFiles.status,
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

async function handleUploadUrlRequest(request, env, dependencies) {
  let body;

  try {
    body = await readJson(request);
  } catch {
    return createResponse(request, env, 400, { error: 'Invalid request body' });
  }

  const validation = validateUploadUrlPayload(body);

  if (validation.error) {
    return createResponse(request, env, validation.status, { error: validation.error });
  }

  if (!env.CHAT_BUCKET_NAME) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }
  const awsConfigError = ensureAwsCredentialsConfigured(request, env);

  if (awsConfigError) {
    return awsConfigError;
  }

  const timestamp = dependencies.now?.() ?? Date.now();
  const conversationId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const extension = getFilenameExtension(validation.filename, validation.contentType);
  const key = `attachments/${conversationId}/${timestamp}-${objectId}${extension}`;
  const region = env.AWS_REGION ?? 'us-east-1';

  try {
    const awsClient = createAwsClient(env, dependencies);
    const uploadUrl = await createPresignedS3Url(
      awsClient,
      {
        bucket: env.CHAT_BUCKET_NAME,
        contentType: validation.contentType,
        key,
        method: 'PUT',
      },
      UPLOAD_URL_EXPIRY_SECONDS,
      region,
      dependencies,
    );

    return createResponse(request, env, 200, { key, uploadUrl });
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }
}

async function handleAttachmentRequest(request, env, dependencies) {
  const key = new URL(request.url).searchParams.get('key') ?? '';

  if (!isValidAttachmentKey(key)) {
    return createResponse(request, env, 400, { error: 'Invalid attachment key' });
  }

  if (!env.CHAT_BUCKET_NAME) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }
  const awsConfigError = ensureAwsCredentialsConfigured(request, env);

  if (awsConfigError) {
    return awsConfigError;
  }

  const region = env.AWS_REGION ?? 'us-east-1';

  try {
    const awsClient = createAwsClient(env, dependencies);
    const downloadUrl = await createPresignedS3Url(
      awsClient,
      {
        bucket: env.CHAT_BUCKET_NAME,
        key,
        method: 'GET',
      },
      DOWNLOAD_URL_EXPIRY_SECONDS,
      region,
      dependencies,
    );

    return createResponse(request, env, 200, { downloadUrl, key });
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }
}

async function handleResponseRequest(request, env, dependencies) {
  const pathname = new URL(request.url).pathname;
  const conversationId = pathname.slice('/api/response/'.length);

  if (!isValidConversationId(conversationId)) {
    return createResponse(request, env, 400, { error: 'Invalid conversation ID' });
  }

  if (!env.CHAT_BUCKET_NAME) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }
  const awsConfigError = ensureAwsCredentialsConfigured(request, env);

  if (awsConfigError) {
    return awsConfigError;
  }

  const prefix = `outbox/${conversationId}/`;
  const region = env.AWS_REGION ?? 'us-east-1';
  let responseFiles;

  try {
    const awsClient = createAwsClient(env, dependencies);
    const objects = await listS3Objects(
      awsClient,
      env.CHAT_BUCKET_NAME,
      prefix,
      25,
      region,
      dependencies,
    );
    responseFiles = describeResponseFiles(prefix, objects);
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }

  if (!responseFiles.audioKey && !responseFiles.transcriptKey) {
    return createResponse(request, env, 404, { error: 'Response not found' });
  }

  try {
    const awsClient = createAwsClient(env, dependencies);
    const [audioUrl, transcriptUrl] = await Promise.all([
      responseFiles.audioKey
        ? createPresignedS3Url(
            awsClient,
            {
              bucket: env.CHAT_BUCKET_NAME,
              key: responseFiles.audioKey,
              method: 'GET',
            },
            DOWNLOAD_URL_EXPIRY_SECONDS,
            region,
            dependencies,
          )
        : Promise.resolve(null),
      responseFiles.transcriptKey
        ? createPresignedS3Url(
            awsClient,
            {
              bucket: env.CHAT_BUCKET_NAME,
              key: responseFiles.transcriptKey,
              method: 'GET',
            },
            DOWNLOAD_URL_EXPIRY_SECONDS,
            region,
            dependencies,
          )
        : Promise.resolve(null),
    ]);

    return createResponse(request, env, 200, { audioUrl, transcriptUrl });
  } catch {
    return createResponse(request, env, 502, { error: 'Bad Gateway' });
  }
}

function getMessageSchemaVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2 ? value : 1;
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

  if (
    body.schemaVersion !== undefined &&
    (!Number.isInteger(body.schemaVersion) || body.schemaVersion < 1 || body.schemaVersion > 2)
  ) {
    return 'Field "schemaVersion" must be 1 or 2';
  }

  if (!body.attachments.every((attachment) => typeof attachment === 'string' && attachment.trim() !== '')) {
    return 'Each attachment must be a non-empty string';
  }

  return null;
}

function deriveConversationStatus(prefix, objects) {
  return describeResponseFiles(prefix, objects).status;
}

function describeResponseFiles(prefix, objects) {
  const keys = objects
    .map((object) => object?.Key)
    .filter((key) => typeof key === 'string');
  const processingKey = `${prefix}${STATUS_PROCESSING_KEY}`;
  const completedKeys = keys.filter((key) => key !== processingKey);
  const transcriptKey =
    completedKeys.find((key) => key.toLowerCase().endsWith(TRANSCRIPT_RESPONSE_EXTENSION)) ?? null;
  const audioKey =
    completedKeys.find((key) => key.toLowerCase().endsWith(AUDIO_RESPONSE_EXTENSION)) ?? null;
  const hasCompleteObject = completedKeys.length > 0;
  const status = hasCompleteObject ? 'complete' : keys.includes(processingKey) ? 'processing' : 'pending';

  return {
    audioKey,
    status,
    transcriptKey,
  };
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

function validateUploadUrlPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object', status: 400 };
  }

  if (typeof body.filename !== 'string' || body.filename.trim() === '') {
    return { error: 'Field "filename" must be a non-empty string', status: 400 };
  }

  if (typeof body.contentType !== 'string' || body.contentType.trim() === '') {
    return { error: 'Field "contentType" must be a non-empty string', status: 400 };
  }

  const contentType = normalizeContentType(body.contentType);

  if (!isAllowedContentType(contentType)) {
    return { error: 'Field "contentType" is not allowed', status: 400 };
  }

  const sizeBytes = getUploadSizeBytes(body);

  if (sizeBytes.error) {
    return { error: sizeBytes.error, status: 400 };
  }

  if (sizeBytes.value !== null && sizeBytes.value > MAX_UPLOAD_BYTES) {
    return { error: 'Attachments must be 25 MB or smaller', status: 413 };
  }

  return {
    contentType,
    filename: body.filename.trim(),
  };
}

function getUploadSizeBytes(body) {
  if (!('sizeBytes' in body) || body.sizeBytes === null) {
    return { error: null, value: null };
  }

  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes < 0) {
    return { error: 'Field "sizeBytes" must be a non-negative integer', value: null };
  }

  return { error: null, value: body.sizeBytes };
}

function normalizeContentType(contentType) {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function isAllowedContentType(contentType) {
  return (
    ALLOWED_CONTENT_TYPES.has(contentType) ||
    ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))
  );
}

function getFilenameExtension(filename, contentType) {
  const match = filename.trim().match(FILENAME_EXTENSION_PATTERN);

  if (match) {
    return `.${match[1].toLowerCase()}`;
  }

  return DEFAULT_EXTENSION_BY_CONTENT_TYPE[contentType] ?? '';
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
  let mismatch = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }

  return mismatch === 0;
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
  const clientIpHeader =
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For');

  if (!clientIpHeader) {
    return 'unknown';
  }

  return clientIpHeader.split(',')[0].trim();
}

function isValidConversationId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isValidAttachmentKey(value) {
  if (!/^attachments\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,256}$/.test(value)) {
    return false;
  }

  const filename = value.split('/').pop() ?? '';
  return !filename.includes('..');
}

function getStatusCacheTtl(env) {
  const rawTtl = parsePositiveInt(env.STATUS_CACHE_TTL_SECONDS, STATUS_CACHE_TTL_SECONDS);

  return Math.min(STATUS_CACHE_MAX_SECONDS, Math.max(STATUS_CACHE_MIN_SECONDS, rawTtl));
}

function createAwsClient(env, dependencies) {
  const credentials = getRequiredAwsCredentials(env);

  return (
    dependencies.createAwsClient?.(env) ??
    new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: env.AWS_REGION ?? 'us-east-1',
    })
  );
}

async function listS3Objects(awsClient, bucket, prefix, maxKeys, region, dependencies) {
  const listUrl = createS3Url(bucket);
  listUrl.searchParams.set('list-type', '2');
  listUrl.searchParams.set('max-keys', String(maxKeys));
  listUrl.searchParams.set('prefix', prefix);
  const fetchList = dependencies.fetchS3List ?? ((client, url, init) => client.fetch(url, init));
  const response = await fetchList(awsClient, listUrl.toString(), {
    method: 'GET',
    aws: {
      region,
      service: 's3',
    },
  });

  if (!response.ok) {
    throw new Error(`S3 list failed with status ${response.status}`);
  }

  const responseXml = await response.text();
  // S3 returns a predictable ListBucketResult payload; we only need <Key> values.
  const keys = [...responseXml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => ({
    Key: decodeXmlText(match[1] ?? ''),
  }));

  return keys;
}

async function createPresignedS3Url(awsClient, request, expiresIn, region, dependencies) {
  const url = createS3Url(request.bucket, request.key);
  const signRequest = dependencies.signS3Request ?? ((client, input, init) => client.sign(input, init));
  const signedRequest = await signRequest(awsClient, url.toString(), {
    method: request.method,
    headers: request.contentType ? { 'Content-Type': request.contentType } : undefined,
    aws: {
      expires: expiresIn,
      region,
      service: 's3',
      signQuery: true,
    },
  });

  return String(signedRequest.url);
}

function createS3Url(bucket, key = '') {
  const baseUrl = new URL(`https://${bucket}.s3.amazonaws.com/`);

  if (!key) {
    return baseUrl;
  }

  baseUrl.pathname = `/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
  return baseUrl;
}

function decodeXmlText(value) {
  // S3 ListObjects XML encodes keys with standard XML entities and numeric references.
  return value.replace(/&(#x[0-9a-fA-F]{1,8}|#[0-9]{1,10}|amp|apos|gt|lt|quot);/g, (match, entity) => {
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }

    return XML_ENTITY_MAP[entity] ?? match;
  });
}

function ensureAwsCredentialsConfigured(request, env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    return createResponse(request, env, 500, { error: 'Internal Server Error' });
  }

  return null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getRequiredAwsCredentials(env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'Failed to create AWS client: missing required environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    );
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
