import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import sessionFileStoreFactory from 'session-file-store';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  isConfigured,
  buildAuthCodeUrl,
  handleCallback,
  getAccessToken,
  getSignedInUser,
  isSignedIn,
  signOut,
  WORKIQ_SCOPE,
  REDIRECT_URI,
} from './auth.js';
import { Trace } from './trace.js';
import * as restAdapter from './adapters/restAdapter.js';
import * as a2aAdapter from './adapters/a2aAdapter.js';
import * as mcpAdapter from './adapters/mcpAdapter.js';
import * as llmAdapter from './adapters/llmAdapter.js';
import { runCoordinator } from './experiments/runCoordinator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('env', 'production');

const redirectUrl = new URL(REDIRECT_URI);
const usesHttps = redirectUrl.protocol === 'https:';
if (usesHttps) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "style-src-attr 'none'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (usesHttps) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Persist sessions to disk so sign-in (and the MSAL token cache stored on the
// session) survives server restarts — no more logging in after every restart.
const FileStore = sessionFileStoreFactory(session);
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SESSION_ABSOLUTE_TTL_MS = SESSION_TTL_SECONDS * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = usesHttps ? '__Host-workiq.sid' : 'connect.sid';
const SESSION_DIR = path.join(__dirname, '..', '.sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SESSION_DIR, 0o700);
for (const entry of fs.readdirSync(SESSION_DIR, { withFileTypes: true })) {
  if (entry.isFile()) fs.chmodSync(path.join(SESSION_DIR, entry.name), 0o600);
}
const sessionStore = new FileStore({
  path: SESSION_DIR,
  ttl: SESSION_TTL_SECONDS,
  retries: 1,
  reapInterval: 60 * 60, // prune expired sessions hourly
  logFn: () => {}, // quiet
});

function secureSessionWrite(method) {
  const original = sessionStore[method].bind(sessionStore);
  sessionStore[method] = (sessionId, value, callback) => {
    original(sessionId, value, (error) => {
      if (!error) {
        try {
          fs.chmodSync(path.join(SESSION_DIR, `${sessionId}.json`), 0o600);
        } catch (chmodError) {
          error = chmodError;
        }
      }
      callback?.(error);
    });
  };
}
secureSessionWrite('set');
secureSessionWrite('touch');

app.use(express.json({ limit: '12mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body exceeds the 12 MB limit.' });
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  next(err);
});
app.use(
  session({
    name: SESSION_COOKIE_NAME,
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh the cookie expiry on activity
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: usesHttps,
      maxAge: SESSION_TTL_SECONDS * 1000,
    },
  })
);
export function enforceAuthenticatedSessionLifetime(req, res, next, now = Date.now()) {
  const authenticatedAt = Number(req.session?.authenticatedAt);
  if (!authenticatedAt && isSignedIn(req.session)) {
    req.session.authenticatedAt = now;
    return next();
  }
  if (!authenticatedAt || now - authenticatedAt <= SESSION_ABSOLUTE_TTL_MS) {
    return next();
  }
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: usesHttps,
      path: '/',
    });
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.', needsLogin: true });
    }
    return res.redirect('/');
  });
}

app.use(enforceAuthenticatedSessionLifetime);
app.use(express.static(path.join(__dirname, '..', 'public')));

const adapters = { rest: restAdapter, a2a: a2aAdapter, mcp: mcpAdapter, llm: llmAdapter };
const WORKIQ_BACKENDS = new Set(['rest', 'a2a', 'mcp']);
const MAX_QUESTION_CHARS = 100_000;
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
// Bounded strings the lab endpoints accept for identifiers (agentId, conversationId, …).
const MAX_BOUNDED_STRING_CHARS = 200;
const MAX_FILE_URLS = 10;
const MAX_FILE_URL_CHARS = 2_048;
const MAX_ADDITIONAL_CONTEXTS = 4;
const MAX_ADDITIONAL_CONTEXT_CHARS = 4_000;

export function canonicalAuthLoginUrl(protocol, host, redirectUri = REDIRECT_URI) {
  const callbackUrl = new URL(redirectUri);
  const requestOrigin = new URL(`${protocol}://${host}`).origin;
  return requestOrigin === callbackUrl.origin ? null : new URL('/auth/login', callbackUrl.origin).href;
}

export function persistSession(currentSession) {
  return new Promise((resolve, reject) => {
    currentSession.save((error) => (error ? reject(error) : resolve()));
  });
}

export function validateSessionSecret(secret = process.env.SESSION_SECRET) {
  const value = typeof secret === 'string' ? secret : '';
  const placeholders = ['dev-only-insecure-secret', 'change-me-to-a-long-random-string'];
  if (Buffer.byteLength(value, 'utf8') < 32 || placeholders.includes(value)) {
    throw new Error('SESSION_SECRET must be a non-placeholder value of at least 32 bytes.');
  }
  if (value === process.env.ENTRA_CLIENT_SECRET) {
    throw new Error('SESSION_SECRET must be different from ENTRA_CLIENT_SECRET.');
  }
  return value;
}

export function requireAuthenticatedSession(req, res) {
  if (isSignedIn(req.session)) return true;
  res.status(401).json({ error: 'Not signed in.', needsLogin: true });
  return false;
}

export function regenerateAuthenticatedSession(req) {
  const authenticated = {
    msalCache: req.session.msalCache,
    homeAccountId: req.session.homeAccountId,
    username: req.session.username,
    authenticatedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      Object.assign(req.session, authenticated);
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

export function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function sendAuthError(res, message) {
  res.status(500).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in error</title></head><body><p>${message}</p><a href="/">Back</a></body></html>`
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ── Session-bound A2A task handles ─────────────────────────────────────────
//
// Direct A2A asks can return a Task (taskId + state). Rather than trust a
// client-supplied taskId for follow-up GetTask/CancelTask/SubscribeToTask
// calls, we hand back an opaque random "handle" and keep the taskId (plus the
// agentId/contextId needed to reach it) server-side, bound to this Express
// session. Handles are capped and expire so the list can't grow unbounded.
export const TASK_HANDLE_MAX = 25;
export const TASK_HANDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function pruneTaskHandles(currentSession) {
  const now = Date.now();
  const handles = Array.isArray(currentSession.a2aTaskHandles) ? currentSession.a2aTaskHandles : [];
  currentSession.a2aTaskHandles = handles.filter((entry) => now - entry.createdAt < TASK_HANDLE_TTL_MS);
  return currentSession.a2aTaskHandles;
}

export function registerTaskHandle(currentSession, { taskId, agentId, contextId, taskState }) {
  const handles = pruneTaskHandles(currentSession);
  const handle = randomUUID();
  handles.push({
    handle,
    taskId,
    agentId: agentId || null,
    contextId: contextId || null,
    taskState: taskState || null,
    createdAt: Date.now(),
  });
  currentSession.a2aTaskHandles = handles.length > TASK_HANDLE_MAX ? handles.slice(-TASK_HANDLE_MAX) : handles;
  return handle;
}

export function findTaskHandle(currentSession, handle) {
  const handles = pruneTaskHandles(currentSession);
  return handles.find((entry) => entry.handle === handle) || null;
}

export function updateTaskHandle(currentSession, handle, patch) {
  const entry = findTaskHandle(currentSession, handle);
  if (entry) Object.assign(entry, patch);
  return entry;
}

function validateAskRequest(body) {
  if (!isPlainObject(body)) return 'A JSON object request body is required.';

  const { mode, question } = body;
  if (typeof mode !== 'string' || typeof question !== 'string' || !question.trim()) {
    return 'mode and question are required strings.';
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return `question must not exceed ${MAX_QUESTION_CHARS.toLocaleString('en-US')} characters.`;
  }

  const adapter = adapters[mode];
  if (!adapter) return `Unknown mode: ${mode}`;
  if (body.streamResponse != null && typeof body.streamResponse !== 'boolean') {
    return 'streamResponse must be a boolean when provided.';
  }

  for (const field of ['conversationId', 'timeZone', 'agentId', 'model']) {
    if (body[field] != null && typeof body[field] !== 'string') {
      return `${field} must be a string when provided.`;
    }
  }
  if (mode === 'rest') {
    const conversationIdError = validateRestConversationId(body.conversationId);
    if (conversationIdError) return conversationIdError;
  }
  if (body.webEnabled != null && typeof body.webEnabled !== 'boolean') {
    return 'webEnabled must be a boolean when provided.';
  }
  if (body.systemPrompt != null) {
    if (mode !== 'llm') return 'systemPrompt is supported only in agent-orchestrated mode.';
    if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim()) {
      return 'systemPrompt must be a non-empty string when provided.';
    }
    if (body.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
      return `systemPrompt must not exceed ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString('en-US')} characters.`;
    }
  }
  if (mode === 'a2a') {
    const agentIdError = a2aAdapter.validateAgentId(body.agentId);
    if (agentIdError) return agentIdError;
  }

  if (body.files != null) {
    const filesError = validateFileUris(body.files);
    if (filesError) return filesError;
  }
  if (mode === 'rest' && body.agentId != null) return 'REST does not support agentId. Use direct A2A or MCP.';
  if (mode === 'a2a' && body.files != null) return 'A2A does not support file context in this app. Use REST or MCP.';
  if (WORKIQ_BACKENDS.has(mode) && mode !== 'rest' && body.webEnabled != null) {
    return 'webEnabled is supported only by REST.';
  }

  if (body.contextFiles != null) {
    return 'contextFiles is not supported by Work IQ REST. Use files with OneDrive or SharePoint HTTPS URLs.';
  }

  if (body.backends != null) {
    if (
      !Array.isArray(body.backends) ||
      body.backends.length === 0 ||
      new Set(body.backends).size !== body.backends.length ||
      body.backends.some((backend) => typeof backend !== 'string' || !WORKIQ_BACKENDS.has(backend))
    ) {
      return 'backends must be a non-empty array containing only rest, a2a, or mcp.';
    }
  }

  if (body.backendConversationIds != null) {
    if (!isPlainObject(body.backendConversationIds)) {
      return 'backendConversationIds must be an object when provided.';
    }
    const invalidEntry = Object.entries(body.backendConversationIds).some(
      ([backend, value]) =>
        !WORKIQ_BACKENDS.has(backend) || (value != null && typeof value !== 'string')
    );
    if (invalidEntry) {
      return 'backendConversationIds may contain only rest, a2a, and mcp string identifiers.';
    }
    const restConversationIdError = validateRestConversationId(body.backendConversationIds.rest);
    if (restConversationIdError) return `backendConversationIds.rest: ${restConversationIdError}`;
  }

  if (body.history != null) {
    if (
      !Array.isArray(body.history) ||
      body.history.some(
        (entry) =>
          !isPlainObject(entry) ||
          !['user', 'assistant'].includes(entry.role) ||
          typeof entry.content !== 'string'
      )
    ) {
      return 'history must contain user or assistant messages with string content.';
    }
  }

  return null;
}

// Direct experiment-workbench targets: only the direct protocols (never the
// composed llm agent), each with its own conversation/agent/context knobs.
// 'inspect' runs exactly one target (a single billable direct request used by
// the frontend Inspector); 'comparison'/'context' compare multiple targets.
const EXPERIMENT_TARGET_COUNTS = { inspect: [1, 1], comparison: [2, 3], context: [2, 8] };

function validateFileUris(files) {
  if (files == null) return null;
  if (!Array.isArray(files)) return 'files must be an array when provided.';
  if (files.length > MAX_FILE_URLS) return `files must not contain more than ${MAX_FILE_URLS} entries.`;
  const invalidFile = files.some((file) => {
    const uri = typeof file === 'string' ? file : file?.uri;
    if (typeof uri !== 'string' || !uri.length || uri.length > MAX_FILE_URL_CHARS) return true;
    try {
      const parsed = new URL(uri);
      return parsed.protocol !== 'https:' || !parsed.hostname || Boolean(parsed.username || parsed.password);
    } catch {
      return true;
    }
  });
  if (invalidFile) {
    return `Each files entry must contain an absolute HTTPS URI without credentials (max ${MAX_FILE_URL_CHARS} characters).`;
  }
  return null;
}

function validateBoundedString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > MAX_BOUNDED_STRING_CHARS) {
    return `${field} must be a string of at most ${MAX_BOUNDED_STRING_CHARS} characters when provided.`;
  }
  return null;
}

function validateRestConversationId(value) {
  const boundedError = validateBoundedString(value, 'conversationId');
  if (boundedError) return boundedError;
  if (value == null) return null;
  if (!value.trim()) return 'conversationId must not be empty when provided.';
  if (/[\\/]/.test(value) || value === '.' || value === '..') {
    return 'conversationId must be an opaque identifier without path separators or dot segments.';
  }
  return null;
}

function validateTimeZone(value) {
  if (value == null) return null;
  const boundedError = validateBoundedString(value, 'timeZone');
  if (boundedError) return boundedError;
  if (!value.trim()) return 'timeZone must not be empty when provided.';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return null;
  } catch {
    return 'timeZone must be a valid IANA time zone.';
  }
}

function validateLocation(location) {
  if (location == null) return null;
  if (!isPlainObject(location)) return 'location must be an object when provided.';
  const allowed = new Set(['latitude', 'longitude', 'countryOrRegion', 'countryOrRegionConfidence']);
  if (Object.keys(location).some((key) => !allowed.has(key))) return 'location contains an unsupported field.';

  const hasLatitude = location.latitude != null;
  const hasLongitude = location.longitude != null;
  if (hasLatitude !== hasLongitude) return 'location latitude and longitude must be provided together.';
  if (hasLatitude && (typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90)) {
    return 'location.latitude must be a number between -90 and 90.';
  }
  if (hasLongitude && (typeof location.longitude !== 'number' || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180)) {
    return 'location.longitude must be a number between -180 and 180.';
  }
  if (
    location.countryOrRegion != null &&
    (typeof location.countryOrRegion !== 'string' || !/^[A-Za-z]{2}$/.test(location.countryOrRegion))
  ) {
    return 'location.countryOrRegion must be a two-letter country or region code.';
  }
  if (
    location.countryOrRegionConfidence != null &&
    (typeof location.countryOrRegionConfidence !== 'number' ||
      !Number.isFinite(location.countryOrRegionConfidence) ||
      location.countryOrRegionConfidence < 0 ||
      location.countryOrRegionConfidence > 1)
  ) {
    return 'location.countryOrRegionConfidence must be a number between 0 and 1.';
  }
  if (location.countryOrRegionConfidence != null && location.countryOrRegion == null) {
    return 'location.countryOrRegion is required when countryOrRegionConfidence is provided.';
  }
  if (!hasLatitude && location.countryOrRegion == null) {
    return 'location must include latitude/longitude or countryOrRegion.';
  }
  return null;
}

function validateAdditionalContext(additionalContext) {
  if (additionalContext == null) return null;
  if (!Array.isArray(additionalContext) || additionalContext.length < 1 || additionalContext.length > MAX_ADDITIONAL_CONTEXTS) {
    return `additionalContext must contain between 1 and ${MAX_ADDITIONAL_CONTEXTS} entries.`;
  }
  const invalid = additionalContext.some(
    (entry) =>
      !isPlainObject(entry) ||
      typeof entry.text !== 'string' ||
      !entry.text.trim() ||
      entry.text.length > MAX_ADDITIONAL_CONTEXT_CHARS ||
      (entry.description != null &&
        (typeof entry.description !== 'string' || entry.description.length > MAX_BOUNDED_STRING_CHARS))
  );
  return invalid
    ? `Each additionalContext entry needs non-empty text (max ${MAX_ADDITIONAL_CONTEXT_CHARS} characters) and an optional description (max ${MAX_BOUNDED_STRING_CHARS} characters).`
    : null;
}

export function validateExperimentRequest(body) {
  if (!isPlainObject(body)) return 'A JSON object request body is required.';
  const { kind, prompt, targets, streaming } = body;

  if (!Object.prototype.hasOwnProperty.call(EXPERIMENT_TARGET_COUNTS, kind)) {
    return "kind must be 'inspect', 'comparison', or 'context'.";
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return 'prompt is required.';
  }
  if (prompt.length > MAX_QUESTION_CHARS) {
    return `prompt must not exceed ${MAX_QUESTION_CHARS.toLocaleString('en-US')} characters.`;
  }
  if (streaming != null && typeof streaming !== 'boolean') {
    return 'streaming must be a boolean when provided.';
  }

  const [minTargets, maxTargets] = EXPERIMENT_TARGET_COUNTS[kind];
  if (!Array.isArray(targets) || targets.length < minTargets || targets.length > maxTargets) {
    return minTargets === maxTargets
      ? `${kind} requires exactly ${minTargets} target${minTargets === 1 ? '' : 's'}.`
      : `${kind} requires between ${minTargets} and ${maxTargets} targets.`;
  }

  const ids = new Set();
  for (const target of targets) {
    if (!isPlainObject(target)) return 'Each target must be an object.';
    const { id, protocol, conversationId, agentId, files, webEnabled, timeZone, location, additionalContext } = target;

    if (typeof id !== 'string' || !id.trim() || id.length > 100) {
      return 'Each target must include a non-empty id (max 100 characters).';
    }
    if (ids.has(id)) return 'Target ids must be unique.';
    ids.add(id);

    if (typeof protocol !== 'string' || !WORKIQ_BACKENDS.has(protocol)) {
      return 'Each target protocol must be rest, a2a, or mcp.';
    }

    const boundedError =
      (protocol === 'rest'
        ? validateRestConversationId(conversationId)
        : validateBoundedString(conversationId, 'conversationId')) ||
      validateBoundedString(agentId, 'agentId') ||
      validateTimeZone(timeZone);
    if (boundedError) return boundedError;

    if (webEnabled != null && typeof webEnabled !== 'boolean') {
      return 'webEnabled must be a boolean when provided.';
    }
    if (protocol === 'rest' && agentId != null) {
      return 'REST experiment targets do not support agentId. Use A2A or MCP.';
    }
    if (protocol === 'a2a') {
      const agentIdError = a2aAdapter.validateAgentId(agentId);
      if (agentIdError) return agentIdError;
    }
    if (protocol === 'a2a' && files != null) {
      return 'A2A experiment targets do not support file context in this app.';
    }
    if (protocol !== 'rest' && webEnabled != null) {
      return 'Only REST experiment targets support webEnabled.';
    }
    if (protocol !== 'rest' && location != null) {
      return 'Only REST experiment targets support geographic location context.';
    }
    if (protocol !== 'rest' && additionalContext != null) {
      return 'Only REST experiment targets support additionalContext.';
    }

    const filesError = validateFileUris(files);
    if (filesError) return filesError;
    const locationError = validateLocation(location);
    if (locationError) return locationError;
    const additionalContextError = validateAdditionalContext(additionalContext);
    if (additionalContextError) return additionalContextError;
  }

  return null;
}

// needs a delegated token depends on those backends (mcp-local self-auths).
function llmNeedsToken(backends) {
  const b = backends && backends.length ? backends : ['mcp'];
  if (b.includes('rest') || b.includes('a2a')) return true;
  if (b.includes('mcp')) return mcpAdapter.requiresToken();
  return true;
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.get('/auth/login', async (req, res) => {
  try {
    const canonicalUrl = canonicalAuthLoginUrl(req.protocol, req.get('host'));
    if (canonicalUrl) return res.redirect(canonicalUrl);

    const url = await buildAuthCodeUrl(req.session);
    await persistSession(req.session);
    res.redirect(url);
  } catch (e) {
    console.error(`[Auth] Sign-in could not start (${e?.name || 'Error'}).`);
    sendAuthError(res, 'Sign-in could not start. Please try again.');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      const safeErrorCode =
        typeof error === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error) ? error : 'oauth_error';
      console.error(`[Auth] Sign-in callback returned ${safeErrorCode}.`);
      return sendAuthError(res, 'Sign-in failed. Please try again.');
    }
    await handleCallback(req.session, code, state);
    await regenerateAuthenticatedSession(req);
    res.redirect('/');
  } catch (e) {
    console.error(`[Auth] Sign-in callback failed (${e?.name || 'Error'}).`);
    sendAuthError(res, 'Sign-in failed. Please try again.');
  }
});

app.post('/api/signout', async (req, res) => {
  const wasSignedIn = isSignedIn(req.session);
  try {
    signOut(req.session);
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: usesHttps,
      path: '/',
    });
    if (wasSignedIn) await mcpAdapter.shutdown();
    res.json({ ok: true });
  } catch (error) {
    console.error(`[Auth] Sign-out failed (${error?.name || 'Error'}).`);
    res.status(500).json({ error: 'Sign-out failed.' });
  }
});

// ── Status ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    configured: isConfigured(),
    signedInUser: getSignedInUser(req.session),
    mcpTransport: mcpAdapter.transportInfo(),
    restTransport: restAdapter.transportInfo(),
  });
});

app.get('/api/lab/config', (req, res) => {
  res.json({
    protocols: {
      rest: {
        endpoint: restAdapter.transportInfo().endpoint,
        channel: restAdapter.transportInfo().channel,
        transport: 'HTTPS + JSON; SSE for streaming',
      },
    },
    runtime: {
      configured: isConfigured(),
      activeMcp: mcpAdapter.transportInfo(),
    },
  });
});

// ── Ask ────────────────────────────────────────────────────────────────────

app.post('/api/ask', async (req, res) => {
  const {
    mode,
    question,
    conversationId,
    timeZone,
    agentId,
    files,
    webEnabled,
    backends,
    model,
    history,
    backendConversationIds,
    systemPrompt,
  } = req.body || {};
  const validationError = validateAskRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!requireAuthenticatedSession(req, res)) return;
  const adapter = adapters[mode];

  const started = Date.now();
  const trace = new Trace();
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    // MCP local self-authenticates; REST, A2A, and remote MCP need a delegated token.
    // The llm agent needs a token if any token-requiring backend is enabled.
    let token;
    const needsToken =
      mode === 'llm' ? llmNeedsToken(backends) : mode !== 'mcp' || mcpAdapter.requiresToken();
    if (needsToken) {
      token = await trace.measure('Acquire delegated token (MSAL)', 'auth', (step) => {
        step.detail = { scope: WORKIQ_SCOPE, user: getSignedInUser(req.session), source: 'cache/refresh' };
        return getAccessToken(req.session);
      });
    } else {
      trace.info('MCP local mode — the Work IQ CLI handles its own sign-in', { kind: 'auth' });
    }

    const result = await adapter.ask({
      question,
      token,
      conversationId,
      timeZone,
      agentId,
      files,
      webEnabled,
      backends,
      model,
      history,
      backendConversationIds,
      systemPrompt,
      signal: abortController.signal,
      trace,
    });
    if (!abortController.signal.aborted) {
      let taskHandle;
      if (mode === 'a2a' && result?.taskId) {
        taskHandle = registerTaskHandle(req.session, {
          taskId: result.taskId,
          agentId,
          contextId: result.conversationId,
          taskState: result.taskState,
        });
        await persistSession(req.session);
      }
      res.json({ ...result, mode, latencyMs: Date.now() - started, ...(taskHandle ? { taskHandle } : {}) });
    }
  } catch (e) {
    if (abortController.signal.aborted) return;
    const status = e.needsLogin ? 401 : 500;
    res.status(status).json({
      error: e.userMessage || e.message,
      needsLogin: Boolean(e.needsLogin),
      trace: trace.toJSON(),
      mode,
      latencyMs: Date.now() - started,
    });
  }
});

// ── Ask (streaming, SSE) ───────────────────────────────────────────────────

app.post('/api/ask/stream', async (req, res) => {
  const {
    mode,
    question,
    conversationId,
    timeZone,
    agentId,
    files,
    webEnabled,
    backends,
    model,
    history,
    backendConversationIds,
    systemPrompt,
  } = req.body || {};
  const validationError = validateAskRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!requireAuthenticatedSession(req, res)) return;
  const adapter = adapters[mode];

  const started = Date.now();
  const abortController = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!clientClosed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  let workIqStarted = false;
  let routeStarted = false;
  const beginWorkIq = (detail) => {
    if (workIqStarted) return;
    workIqStarted = true;
    send('lifecycle', { stage: 'route', state: 'complete', detail });
    send('lifecycle', {
      stage: 'workiq',
      state: 'running',
      detail: 'Permissions, tenant policy, reasoning, and grounding apply inside Work IQ',
    });
  };
  const trace = new Trace({
    onStep: (step) => {
      send('trace_step', step);
      if (
        routeStarted &&
        mode !== 'llm' &&
        step.state === 'running' &&
        ['http', 'process', 'tool'].includes(step.kind)
      ) {
        beginWorkIq(`${mode.toUpperCase()} request sent to Work IQ`);
      }
    },
  });

  try {
    const needsToken =
      mode === 'llm' ? llmNeedsToken(backends) : mode !== 'mcp' || mcpAdapter.requiresToken();
    let token;
    send('lifecycle', {
      stage: 'identity',
      state: 'running',
      detail: needsToken ? 'Acquiring delegated Work IQ token' : 'Local CLI owns delegated sign-in',
    });
    if (needsToken) {
      token = await trace.measure('Acquire delegated token (MSAL)', 'auth', (step) => {
        step.detail = { scope: WORKIQ_SCOPE, user: getSignedInUser(req.session), source: 'cache/refresh' };
        return getAccessToken(req.session);
      });
    }
    send('lifecycle', {
      stage: 'identity',
      state: 'complete',
      detail: needsToken ? 'Delegated user token ready' : 'Authentication delegated to Work IQ CLI',
    });
    send('lifecycle', {
      stage: 'route',
      state: 'running',
      detail: `Opening ${mode === 'llm' ? 'agent orchestration' : mode.toUpperCase()} connection`,
    });
    routeStarted = true;

    const streamResponse = req.body.streamResponse !== false;
    const askMethod =
      streamResponse && typeof adapter.askStream === 'function'
        ? adapter.askStream.bind(adapter)
        : adapter.ask.bind(adapter);
    const result = await askMethod({
      question,
      token,
      conversationId,
      timeZone,
      agentId,
      files,
      webEnabled,
      backends,
      model,
      history,
      backendConversationIds,
      systemPrompt,
      signal: abortController.signal,
      trace,
      onEvent: (evt) => {
        const beginsWorkIqCall = mode !== 'llm' || evt.type === 'agent_step' || evt.type === 'tool_result';
        if (!workIqStarted && beginsWorkIqCall) {
          beginWorkIq(
            mode === 'llm' ? 'Agent selected a Work IQ tool' : `Work IQ accepted the ${mode.toUpperCase()} request`
          );
        }
        send(evt.type, evt);
      },
    });
    if (!workIqStarted) {
      send('lifecycle', {
        stage: 'route',
        state: 'complete',
        detail: mode === 'llm' ? 'Agent completed without a Work IQ tool call' : `${mode.toUpperCase()} request completed`,
      });
    }
    for (const stage of ['workiq', 'answer']) {
      send('lifecycle', {
        stage,
        state: 'complete',
        detail:
          stage === 'workiq'
            ? workIqStarted
              ? 'Work IQ returned governed, grounded result data'
              : 'No Work IQ tool call was required'
            : stage === 'answer'
              ? 'Response and available evidence returned to the app'
              : undefined,
      });
    }
    let taskHandle;
    if (mode === 'a2a' && result?.taskId) {
      taskHandle = registerTaskHandle(req.session, {
        taskId: result.taskId,
        agentId,
        contextId: result.conversationId,
        taskState: result.taskState,
      });
      await persistSession(req.session);
    }
    send('result', {
      ...result,
      mode,
      responseStreamed: streamResponse && typeof adapter.askStream === 'function',
      latencyMs: Date.now() - started,
      ...(taskHandle ? { taskHandle } : {}),
    });
  } catch (e) {
    if (abortController.signal.aborted) return;
    send('lifecycle', { stage: 'answer', state: 'error', detail: e.userMessage || e.message });
    send('error', {
      error: e.userMessage || e.message,
      needsLogin: Boolean(e.needsLogin),
      trace: trace.toJSON(),
      mode,
      latencyMs: Date.now() - started,
    });
  } finally {
    if (!clientClosed && !res.writableEnded) res.end();
  }
});

// Helper: acquire the delegated token only when the active MCP transport needs it.
async function mcpToken(req, trace) {
  if (!mcpAdapter.requiresToken()) return undefined;
  return trace.measure('Acquire delegated token (MSAL)', 'auth', (step) => {
    step.detail = { scope: WORKIQ_SCOPE, user: getSignedInUser(req.session), source: 'cache/refresh' };
    return getAccessToken(req.session);
  });
}

// Agent (LLM) configuration — endpoint host, available models, auth mode.
app.get('/api/llm/config', (req, res) => {
  if (!requireAuthenticatedSession(req, res)) return;
  try {
    res.json(llmAdapter.config());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discover agents available to the MCP "ask" tool when the active server exposes list_agents.
app.get('/api/mcp/agents', async (req, res) => {
  if (!requireAuthenticatedSession(req, res)) return;
  const trace = new Trace();
  try {
    const token = await mcpToken(req, trace);
    const { agents } = await mcpAdapter.listAgents({ token, trace });
    res.json({ agents });
  } catch (e) {
    res.status(e.needsLogin ? 401 : 500).json({ error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin), trace: trace.toJSON() });
  }
});

// Helper: acquire the delegated Work IQ token, recording the step into `trace`.
function acquireDelegatedToken(req, trace) {
  return trace.measure('Acquire delegated token (MSAL)', 'auth', (step) => {
    step.detail = { scope: WORKIQ_SCOPE, user: getSignedInUser(req.session), source: 'cache/refresh' };
    return getAccessToken(req.session);
  });
}

// ── Experiment workbench: run 1-4 direct protocol targets concurrently ─────

app.post('/api/lab/experiments/stream', async (req, res) => {
  const validationError = validateExperimentRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!requireAuthenticatedSession(req, res)) return;
  const { kind, prompt, targets, streaming = true } = req.body;

  const abortController = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!clientClosed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    // Only acquire the delegated token if a selected target actually needs one.
    const needsToken = targets.some(
      (target) => target.protocol === 'rest' || target.protocol === 'a2a' || (target.protocol === 'mcp' && mcpAdapter.requiresToken())
    );
    let token;
    if (needsToken) {
      const authTrace = new Trace();
      token = await acquireDelegatedToken(req, authTrace);
    }

    let registeredTask = false;
    let terminalResult = null;
    const runResult = await runCoordinator({
      kind,
      prompt,
      targets,
      token,
      streamResponses: streaming,
      signal: abortController.signal,
      onEvent: (type, data) => {
        if (type === 'target_result' && data.protocol === 'a2a' && data.taskId) {
          const target = targets.find((candidate) => candidate.id === data.targetId);
          data.taskHandle = registerTaskHandle(req.session, {
            taskId: data.taskId,
            agentId: target?.agentId,
            contextId: data.conversationId,
            taskState: data.taskState,
          });
          registeredTask = true;
        }
        if (type === 'run_result') {
          terminalResult = data;
          return;
        }
        send(type, data);
      },
    });
    if (registeredTask) await persistSession(req.session);
    send('run_result', terminalResult || runResult);
  } catch (e) {
    if (!abortController.signal.aborted) {
      send('error', { error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin) });
    }
  } finally {
    if (!clientClosed && !res.writableEnded) res.end();
  }
});

// ── A2A Agent Cards (fixed gateway, no caller-supplied host) ───────────────

app.get('/api/lab/a2a/agent-card', async (req, res) => {
  const { agentId } = req.query;
  if (agentId != null && typeof agentId !== 'string') {
    return res.status(400).json({ error: 'agentId must be a string when provided.' });
  }

  const trace = new Trace();
  try {
    const token = await acquireDelegatedToken(req, trace);
    const { card } = await a2aAdapter.getAgentCard({ token, agentId: agentId || undefined, trace });
    res.json({ card, trace: trace.toJSON() });
  } catch (e) {
    const status = e.needsLogin ? 401 : /agentId/i.test(e.message || '') ? 400 : 500;
    res.status(status).json({ error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin), trace: trace.toJSON() });
  }
});

// ── Session-bound A2A task handles ─────────────────────────────────────────

const TASK_HANDLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateTaskHandle(handle) {
  return typeof handle === 'string' && TASK_HANDLE_PATTERN.test(handle)
    ? null
    : 'handle must be a canonical server-generated UUID.';
}

app.post('/api/lab/a2a/tasks/get', async (req, res) => {
  const { handle } = req.body || {};
  const handleError = validateTaskHandle(handle);
  if (handleError) return res.status(400).json({ error: handleError });
  const entry = findTaskHandle(req.session, handle);
  if (!entry) return res.status(404).json({ error: 'Unknown or expired task handle.' });

  const trace = new Trace();
  try {
    const token = await acquireDelegatedToken(req, trace);
    const result = await a2aAdapter.getTask({ token, agentId: entry.agentId, taskId: entry.taskId, trace });
    updateTaskHandle(req.session, handle, { taskState: result.taskState, contextId: result.contextId ?? entry.contextId });
    await persistSession(req.session);
    res.json({
      handle,
      taskId: entry.taskId,
      taskState: result.taskState,
      contextId: result.contextId,
      task: result.task,
      trace: result.trace,
    });
  } catch (e) {
    res.status(e.needsLogin ? 401 : 500).json({ error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin), trace: trace.toJSON() });
  }
});

app.post('/api/lab/a2a/tasks/cancel', async (req, res) => {
  const { handle } = req.body || {};
  const handleError = validateTaskHandle(handle);
  if (handleError) return res.status(400).json({ error: handleError });
  const entry = findTaskHandle(req.session, handle);
  if (!entry) return res.status(404).json({ error: 'Unknown or expired task handle.' });
  if (entry.taskState && a2aAdapter.TERMINAL_TASK_STATES.has(entry.taskState)) {
    return res.status(409).json({ error: `Task is already in a terminal state (${entry.taskState}).`, taskState: entry.taskState });
  }

  const trace = new Trace();
  try {
    const token = await acquireDelegatedToken(req, trace);
    const result = await a2aAdapter.cancelTask({ token, agentId: entry.agentId, taskId: entry.taskId, trace });
    updateTaskHandle(req.session, handle, { taskState: result.taskState, contextId: result.contextId ?? entry.contextId });
    await persistSession(req.session);
    res.json({
      handle,
      taskId: entry.taskId,
      taskState: result.taskState,
      contextId: result.contextId,
      task: result.task,
      trace: result.trace,
    });
  } catch (e) {
    res.status(e.needsLogin ? 401 : 500).json({ error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin), trace: trace.toJSON() });
  }
});

const TASK_SUBSCRIBE_MAX_MS = 120_000;
const TASK_SUBSCRIBE_MAX_EVENTS = 500;

app.post('/api/lab/a2a/tasks/subscribe', async (req, res) => {
  const { handle } = req.body || {};
  const handleError = validateTaskHandle(handle);
  if (handleError) return res.status(400).json({ error: handleError });
  const entry = findTaskHandle(req.session, handle);
  if (!entry) return res.status(404).json({ error: 'Unknown or expired task handle.' });
  if (entry.taskState && a2aAdapter.TERMINAL_TASK_STATES.has(entry.taskState)) {
    return res.status(409).json({ error: `Task is already in a terminal state (${entry.taskState}).`, taskState: entry.taskState });
  }

  const trace = new Trace();
  const abortController = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!clientClosed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const timeoutTimer = setTimeout(() => abortController.abort(), TASK_SUBSCRIBE_MAX_MS);
  let eventCount = 0;
  let endReason = null;

  try {
    const token = await acquireDelegatedToken(req, trace);
    await a2aAdapter.subscribeToTask({
      token,
      agentId: entry.agentId,
      taskId: entry.taskId,
      trace,
      signal: abortController.signal,
      onEvent: (evt) => {
        eventCount += 1;
        send('protocol_event', evt);

        const state = a2aAdapter.taskStateFromEvent(evt);
        const contextId = a2aAdapter.contextIdFromEvent(evt);
        if (state || contextId) {
          updateTaskHandle(req.session, handle, {
            ...(state ? { taskState: state } : {}),
            ...(contextId ? { contextId } : {}),
          });
        }
        if (state && a2aAdapter.TERMINAL_TASK_STATES.has(state)) {
          endReason = 'terminal_state';
          abortController.abort();
        } else if (eventCount >= TASK_SUBSCRIBE_MAX_EVENTS) {
          endReason = 'max_events';
          abortController.abort();
        }
      },
    });
    if (!endReason) endReason = 'completed';
  } catch (e) {
    if (abortController.signal.aborted) {
      if (!endReason) endReason = clientClosed ? 'client_abort' : 'timeout';
    } else {
      send('error', { error: e.userMessage || e.message, needsLogin: Boolean(e.needsLogin) });
      endReason = 'error';
    }
  } finally {
    clearTimeout(timeoutTimer);
    try {
      await persistSession(req.session);
    } catch (error) {
      send('warning', { warning: 'The latest task state could not be saved to this browser session.' });
      console.error('Failed to persist A2A task subscription state:', error);
    }
    if (!clientClosed && !res.writableEnded) {
      send('complete', { reason: endReason, eventCount });
      res.end();
    }
  }
});

// ── Capability matrix (documented vs. app vs. runtime evidence) ────────────

const CAPABILITY_ROWS = [
  { key: 'messaging', label: 'Send a message / ask' },
  { key: 'streaming', label: 'Streamed (incremental) responses' },
  { key: 'continuation', label: 'Multi-turn continuation (conversation/context id)' },
  { key: 'citations', label: 'Structured citations/sources' },
  { key: 'agentRouting', label: 'Route to a specific installed agent' },
  { key: 'fileContext', label: 'Attach OneDrive/SharePoint file context' },
  { key: 'webGrounding', label: 'Web search grounding toggle' },
  { key: 'agentDiscovery', label: 'Discover available agents' },
  { key: 'agentCards', label: 'Fetch Agent Cards' },
  { key: 'taskGet', label: 'Get task status' },
  { key: 'taskCancel', label: 'Cancel a task' },
  { key: 'taskSubscribe', label: 'Subscribe to task updates (stream)' },
  { key: 'cancellation', label: 'Client-side request cancellation' },
  { key: 'rawEventVisibility', label: 'Raw protocol event visibility' },
];

// Static documented/app-level facts, sourced from the adapters in this app —
// never a live/billable call. `app` reflects what THIS app's adapters do today.
// `value` (only set where the plain app boolean isn't the right display value,
// e.g. rawEventVisibility) overrides the capability's rendered value/badge.
const STATIC_CAPABILITIES = {
  rest: {
    messaging: { documented: true, app: true },
    streaming: { documented: true, app: true },
    continuation: { documented: true, app: true },
    citations: { documented: true, app: true },
    agentRouting: { documented: false, app: false, note: 'Work IQ REST has no agent-routing parameter.' },
    fileContext: { documented: true, app: true },
    webGrounding: { documented: true, app: true },
    agentDiscovery: { documented: false, app: false },
    agentCards: { documented: false, app: false },
    taskGet: { documented: false, app: false },
    taskCancel: { documented: false, app: false },
    taskSubscribe: { documented: false, app: false },
    cancellation: { documented: true, app: true, note: 'Aborting the HTTP/SSE request stops the call.' },
    rawEventVisibility: { documented: true, app: true, value: 'Wire-level', note: 'Redacted raw HTTP request/response JSON.' },
  },
  a2a: {
    messaging: { documented: true, app: true },
    streaming: { documented: true, app: true },
    continuation: { documented: true, app: true },
    citations: { documented: true, app: true },
    agentRouting: { documented: true, app: true },
    fileContext: { documented: false, app: false, note: 'This app does not attach file context over A2A.' },
    webGrounding: { documented: false, app: false },
    agentDiscovery: { documented: false, app: false, note: 'No agent-discovery method is used by this app.' },
    agentCards: { documented: true, app: true },
    taskGet: { documented: true, app: true },
    taskCancel: { documented: true, app: true },
    taskSubscribe: { documented: true, app: true },
    cancellation: { documented: true, app: true },
    rawEventVisibility: { documented: true, app: true, value: 'Wire-level', note: 'Redacted raw HTTP/SSE request/response JSON.' },
  },
  mcp: {
    messaging: { documented: true, app: true },
    streaming: { documented: false, app: false, note: 'The MCP ask tool is request/response only.' },
    continuation: { documented: true, app: true },
    citations: { documented: false, app: false, note: 'MCP ask exposes no structured citation data.' },
    agentRouting: { documented: true, app: true },
    fileContext: { documented: true, app: true },
    webGrounding: { documented: false, app: false },
    agentDiscovery: { documented: true, app: true },
    agentCards: { documented: false, app: false },
    taskGet: { documented: false, app: false },
    taskCancel: { documented: false, app: false },
    taskSubscribe: { documented: false, app: false },
    cancellation: { documented: true, app: true },
    rawEventVisibility: { documented: true, app: true, value: 'SDK-level', note: 'Limited to what the MCP SDK client surfaces (no raw wire bytes).' },
  },
};

// Builds a short human-readable evidence string for one protocol+capability
// cell, combining the documented/app/runtime tiers and any static note.
function describeEvidence(fact, runtimeValue) {
  const parts = [`Documented: ${fact.documented ? 'yes' : 'no'}`, `App: ${fact.app ? 'yes' : 'no'}`];
  if (runtimeValue !== undefined) parts.push(`Runtime: ${runtimeValue ? 'confirmed' : 'not observed'}`);
  if (fact.note) parts.push(fact.note);
  return parts.join(' · ');
}

// MCP runtime evidence derives from the CURRENT tool schemas (tools/list only —
// never invoking the "ask" tool, which would be a billable Work IQ call).
async function mcpRuntimeFacts(req) {
  try {
    if (!isSignedIn(req.session)) return { error: 'Not signed in.' };
    let token;
    if (mcpAdapter.requiresToken()) {
      token = await getAccessToken(req.session);
    }
    const { tools } = await mcpAdapter.inspectTools({ token });
    const names = tools.map((t) => String(t.name || '').toLowerCase());
    const askTool = tools.find((t) => /ask/i.test(t.name || ''));
    const askProps = askTool?.inputSchema?.properties ? Object.keys(askTool.inputSchema.properties) : [];
    return {
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
      tools,
      facts: {
        messaging: Boolean(askTool),
        agentDiscovery: names.some((n) => /^list_agents?$/.test(n)),
        agentRouting: askProps.includes('agentId'),
        fileContext: askProps.includes('fileUrls') || askProps.includes('files'),
        continuation: askProps.includes('conversationId'),
      },
    };
  } catch (e) {
    return { error: e.userMessage || e.message || 'MCP runtime unavailable.' };
  }
}

app.get('/api/lab/capabilities', async (req, res) => {
  const mcpRuntime = await mcpRuntimeFacts(req);

  // rows: legacy per-capability array (key/label/{documented,app,runtime?,note?}
  // per protocol) — kept for any consumer that already relies on it.
  const rows = CAPABILITY_ROWS.map(({ key, label }) => {
    const row = { key, label };
    for (const protocol of ['rest', 'a2a', 'mcp']) {
      const base = STATIC_CAPABILITIES[protocol][key] || { documented: false, app: false };
      row[protocol] = { ...base };
    }
    // Only MCP carries live runtime evidence — a signed-out/unavailable runtime
    // leaves the static documented/app facts untouched (never forced to false).
    if (!mcpRuntime.error && mcpRuntime.facts && key in mcpRuntime.facts) {
      row.mcp.runtime = mcpRuntime.facts[key];
    }
    return row;
  });

  // protocols: the stable, frontend-facing shape — keyed by protocol name,
  // each with a flat `capabilities` value map and an `evidence` string map.
  // `evidence` is mirrored at the top level too (evidence[protocol][key]) so
  // callers can look it up either as protocols[p].evidence[key] or
  // evidence[p][key].
  const protocols = {};
  const evidence = {};
  for (const protocol of ['rest', 'a2a', 'mcp']) {
    const capabilities = {};
    const protocolEvidence = {};
    const facts = {};
    for (const { key } of CAPABILITY_ROWS) {
      const fact = STATIC_CAPABILITIES[protocol][key] || { documented: false, app: false };
      const runtimeValue =
        protocol === 'mcp' && !mcpRuntime.error && mcpRuntime.facts && key in mcpRuntime.facts
          ? mcpRuntime.facts[key]
          : undefined;
      capabilities[key] = fact.value !== undefined ? fact.value : runtimeValue !== undefined ? runtimeValue : fact.app;
      protocolEvidence[key] = describeEvidence(fact, runtimeValue);
      facts[key] = runtimeValue !== undefined ? { ...fact, runtime: runtimeValue } : { ...fact };
    }
    protocols[protocol] = { capabilities, evidence: protocolEvidence, facts };
    evidence[protocol] = protocolEvidence;
  }

  res.json({
    generatedAt: new Date().toISOString(),
    protocolList: ['rest', 'a2a', 'mcp'],
    protocols,
    evidence,
    rows,
    runtime: {
      // Top-level fields match what the Inspector reads directly (runtime.error).
      ...(mcpRuntime.error
        ? { error: mcpRuntime.error }
        : { toolCount: mcpRuntime.toolCount, toolNames: mcpRuntime.toolNames, tools: mcpRuntime.tools }),
      mcp: mcpRuntime.error
        ? { available: false, error: mcpRuntime.error }
        : {
            available: true,
            toolCount: mcpRuntime.toolCount,
            toolNames: mcpRuntime.toolNames,
            tools: mcpRuntime.tools,
          },
    },
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  console.error(`[Server] ${req.method} ${req.path} failed (${err?.name || 'Error'}, HTTP ${status}).`);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      error: status >= 500 ? 'Internal server error.' : 'Invalid request.',
    });
  }
  return res.status(status).type('text').send(status >= 500 ? 'Internal server error.' : 'Invalid request.');
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function resolveListenHost(host = process.env.HOST) {
  const resolved = typeof host === 'string' && host.trim() ? host.trim() : '127.0.0.1';
  const allowsRemote = process.env.WORKIQ_ALLOW_REMOTE_BIND === 'true';
  if (!LOOPBACK_HOSTS.has(resolved) && !allowsRemote) {
    throw new Error(
      'Refusing a non-loopback listener. Set WORKIQ_ALLOW_REMOTE_BIND=true only behind a hardened HTTPS proxy.'
    );
  }
  return resolved;
}

export function startServer(port = process.env.PORT || 3000, host = process.env.HOST) {
  const resolvedHost = resolveListenHost(host);
  validateSessionSecret();
  if (!LOOPBACK_HOSTS.has(resolvedHost) && !usesHttps) {
    throw new Error('Refusing a non-loopback listener with a non-HTTPS redirect URI.');
  }
  if (mcpAdapter.transportInfo().transport === 'local' && !LOOPBACK_HOSTS.has(resolvedHost)) {
    throw new Error('Local MCP is restricted to a loopback listener because the CLI uses a separate cached identity.');
  }
  return app.listen(port, resolvedHost, () => {
    console.log(`\nWork IQ Test Lab running at ${redirectUrl.origin}\n`);
    if (!isConfigured()) {
      console.log(
        '⚠  ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET not set. Copy .env.example to .env first.\n'
      );
    }
  });
}

export { app };

let server;
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) server = startServer();

async function cleanup() {
  await mcpAdapter.shutdown();
  if (server) {
    server.close(() => process.exit(0));
    return;
  }
  process.exit(0);
}
if (isMain) {
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
