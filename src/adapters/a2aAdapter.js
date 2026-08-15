import { randomUUID } from 'node:crypto';
import { Trace, tracedFetch, tracedStream } from '../trace.js';
import { sourcesFromPayload } from '../sourceNormalizer.js';

const GATEWAY = process.env.WORKIQ_GATEWAY || 'https://workiq.svc.cloud.microsoft';
const A2A_URL = `${GATEWAY}/a2a/`;

export function timeZoneOffsetMinutes(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce((values, part) => {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
      return values;
    }, {});
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

function locationMetadata(timeZone) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const offset = timeZoneOffsetMinutes(tz);
  return { Location: { timeZoneOffset: offset, timeZone: tz } };
}

/**
 * Ask Work IQ via the A2A protocol (JSON-RPC SendMessage, v1.0).
 * @param {{question:string, token:string, conversationId?:string, timeZone?:string, agentId?:string, trace?:Trace}} opts
 * @returns {Promise<{answer:string, sources:Array, conversationId:string|null, raw:object, trace:Array}>}
 */
export async function ask({ question, token, conversationId, timeZone, agentId, trace, signal }) {
  trace = trace || new Trace();
  assertValidAgentId(agentId);

  const message = {
    role: 'ROLE_USER',
    messageId: randomUUID(),
    parts: [{ text: question }],
    metadata: locationMetadata(timeZone),
  };
  if (conversationId) {
    message.contextId = conversationId;
    trace.info(`Continuing conversation (contextId ${conversationId})`, { kind: 'info' });
  }

  const body = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendMessage',
    params: { message },
  };

  const url = agentUrl(agentId);
  const { res, json: raw } = await tracedFetch(trace, 'JSON-RPC SendMessage', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || raw?.error) {
    const msg = raw?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(`A2A request failed: ${msg}`);
  }

  const result = raw?.result ?? {};
  const task = result.task ?? {};
  const answer = result.task ? extractAnswer(task) : partsText(result.message?.parts) || '(no answer text returned)';
  const sources = sourcesFromPayload(result, answer);
  trace.info(
    `Parsed task ${task.status?.state || '(no state)'}: ${(task.artifacts ?? []).length} artifact(s), ${sources.length} source(s)`,
    { kind: 'parse' }
  );

  return {
    answer,
    sources,
    conversationId: task.contextId ?? result.message?.contextId ?? conversationId ?? null,
    taskId: task.id ?? null,
    taskState: task.status?.state ?? null,
    raw,
    trace: trace.toJSON(),
  };
}

function extractAnswer(task) {
  const texts = [];
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (typeof part.text === 'string') texts.push(part.text);
    }
  }
  if (texts.length) return texts.join('\n');
  if (task.status?.state && task.status.state !== 'TASK_STATE_COMPLETED') {
    return `(no answer text — task state: ${task.status.state})`;
  }
  return '(no answer text returned)';
}

function partsText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

function extractContextId(result) {
  for (const key of ['task', 'message', 'statusUpdate', 'artifactUpdate']) {
    const v = result[key];
    if (v && typeof v.contextId === 'string') return v.contextId;
  }
  return null;
}

// Task identity/state can arrive on the initial `task` snapshot or on any of
// the incremental update envelopes (naming mirrors the A2A v1 wire shapes).
function extractTaskId(result) {
  const task = result.task;
  if (task && typeof task.id === 'string') return task.id;
  for (const key of ['statusUpdate', 'artifactUpdate']) {
    const v = result[key];
    if (v && typeof v.taskId === 'string') return v.taskId;
  }
  return null;
}

function extractTaskState(result) {
  if (result.task?.status?.state) return result.task.status.state;
  if (result.statusUpdate?.status?.state) return result.statusUpdate.status.state;
  return null;
}

// Terminal task states: once reached, GetTask/CancelTask will not move further
// and a client-side Cancel should be rejected without an upstream call.
export const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_CANCELLED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
]);

/** Extract the task state carried by a raw SubscribeToTask/streaming SSE event (`{result: ...}`). */
export function taskStateFromEvent(evt) {
  return extractTaskState(evt?.result ?? {});
}

/** Extract the contextId carried by a raw SubscribeToTask/streaming SSE event (`{result: ...}`). */
export function contextIdFromEvent(evt) {
  return extractContextId(evt?.result ?? {});
}

/** Extract the taskId carried by a raw SubscribeToTask/streaming SSE event (`{result: ...}`). */
export function taskIdFromEvent(evt) {
  return extractTaskId(evt?.result ?? {});
}

/**
 * Streaming variant: SendStreamingMessage (SSE). Work IQ uses delta semantics —
 * each artifactUpdate carries the new tail (append=true), which we concatenate
 * per artifactId. statusUpdate events carry user-facing progress, which we
 * surface as 'status' events so the UI can show that the task is advancing.
 * @param {{question, token, conversationId?, timeZone?, agentId?, trace?:Trace, onEvent:Function}} opts
 */
export async function askStream({
  question,
  token,
  conversationId,
  timeZone,
  agentId,
  trace,
  onEvent,
  signal,
}) {
  trace = trace || new Trace();
  assertValidAgentId(agentId);

  const message = {
    role: 'ROLE_USER',
    messageId: randomUUID(),
    parts: [{ text: question }],
    metadata: locationMetadata(timeZone),
  };
  if (conversationId) {
    message.contextId = conversationId;
    trace.info(`Continuing conversation (contextId ${conversationId})`, { kind: 'info' });
  }

  const body = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendStreamingMessage',
    params: { message },
  };

  const url = agentUrl(agentId);

  const artifactBuffers = new Map();
  const sourcePayloads = [];
  let ctxId = conversationId || null;
  let taskId = null;
  let taskState = null;
  let lastStatusText = null;
  let lastRaw = null;
  let messageAnswer = '';

  await tracedStream(
    trace,
    'JSON-RPC SendStreamingMessage (SSE)',
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'A2A-Version': '1.0',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
    (evt) => {
      lastRaw = evt;
      if (evt?.error) throw new Error(evt.error.message || 'A2A stream error');
      const result = evt?.result;
      if (!result) return;
      ctxId = extractContextId(result) ?? ctxId;
      taskId = extractTaskId(result) ?? taskId;
      taskState = extractTaskState(result) ?? taskState;
      if (sourcesFromPayload(result).length) sourcePayloads.push(result);

      if (result.artifactUpdate) {
        const au = result.artifactUpdate;
        const artifact = au.artifact;
        if (!artifact) return;
        const aId = artifact.artifactId || '';
        const append = au.append === true;

        const chunk = partsText(artifact.parts);
        if (!chunk) return;
        const prev = artifactBuffers.get(aId) || '';

        if (append) {
          artifactBuffers.set(aId, prev + chunk);
          onEvent({ type: 'delta', text: chunk });
        } else {
          // Replace semantics: Work IQ "Full" mode extends the prior text.
          artifactBuffers.set(aId, chunk);
          if (chunk.startsWith(prev)) {
            const suffix = chunk.slice(prev.length);
            if (suffix) onEvent({ type: 'delta', text: suffix });
          } else {
            onEvent({ type: 'delta', text: chunk, replace: true });
          }
        }
      } else if (result.statusUpdate) {
        const statusMsg = result.statusUpdate.status?.message;
        const thought = statusMsg ? partsText(statusMsg.parts) : '';
        if (thought && thought !== lastStatusText) {
          lastStatusText = thought;
          onEvent({ type: 'status', text: thought });
        }
      } else if (result.message) {
        const t = partsText(result.message.parts);
        if (t) {
          messageAnswer += t;
          onEvent({ type: 'delta', text: t });
        }
      }
    }
  );

  const answer = [...artifactBuffers.values()].join('\n') || messageAnswer || '(no answer text returned)';
  const sources = sourcesFromPayload(sourcePayloads, answer);
  trace.info(`Stream complete: ${answer.length} char(s), ${sources.length} source(s)`, {
    kind: 'parse',
  });

  return {
    answer,
    sources,
    conversationId: ctxId,
    taskId,
    taskState,
    raw: lastRaw,
    trace: trace.toJSON(),
  };
}

// ── Agent Cards ──────────────────────────────────────────────────────────
//
// Agent Card discovery is intentionally restricted to the app's own configured
// gateway and two fixed, well-known paths — callers can select *which* agent
// card to fetch (by agentId) but never *which host* to fetch it from.

const AGENT_ID_MAX_CHARS = 128;

export function validateAgentId(agentId) {
  if (agentId == null) return null;
  if (typeof agentId !== 'string' || !agentId.length) {
    return 'agentId must be a non-empty string when provided.';
  }
  if (agentId.length > AGENT_ID_MAX_CHARS) {
    return `agentId must not exceed ${AGENT_ID_MAX_CHARS} characters.`;
  }
  if (/[\\/]/.test(agentId)) {
    return 'agentId must not contain a slash or backslash.';
  }
  if (agentId === '.' || agentId === '..') {
    return 'agentId must not be a dot-segment path.';
  }
  return null;
}

function assertValidAgentId(agentId) {
  const error = validateAgentId(agentId);
  if (error) throw new Error(error);
}

/**
 * Fetch the A2A Agent Card — either the gateway's default card, or a specific
 * installed agent's card. Uses ONLY the configured WORKIQ_GATEWAY and the exact
 * fixed well-known paths (never a caller-supplied URL/host).
 * @param {{token:string, agentId?:string, trace?:Trace, signal?:AbortSignal}} opts
 * @returns {Promise<{card:object, raw:object, trace:Array}>}
 */
export async function getAgentCard({ token, agentId, trace, signal }) {
  trace = trace || new Trace();
  assertValidAgentId(agentId);

  const path = agentId
    ? `/a2a/${encodeURIComponent(agentId)}/.well-known/agent-card.json`
    : '/a2a/.well-known/agent-card.json';
  const url = `${GATEWAY}${path}`;

  const { res, json: raw } = await tracedFetch(trace, 'GET Agent Card', url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal,
  });

  if (!res.ok) {
    const msg = raw?.error?.message || raw?.message || `${res.status} ${res.statusText}`;
    throw new Error(`Agent card request failed: ${msg}`);
  }

  return { card: raw, raw, trace: trace.toJSON() };
}

// ── A2A v1 Task methods (GetTask / CancelTask / SubscribeToTask) ──────────
//
// All task calls go to the SAME fixed gateway/agent path used for SendMessage;
// only the JSON-RPC method and params differ. Callers never supply a raw
// taskId directly — the server resolves an opaque, session-bound handle to a
// taskId before calling these.

function agentUrl(agentId) {
  return agentId ? `${GATEWAY}/a2a/${encodeURIComponent(agentId)}/` : A2A_URL;
}

async function callTaskMethod(method, { token, agentId, taskId, trace, signal }) {
  trace = trace || new Trace();
  assertValidAgentId(agentId);
  const body = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params: { id: taskId },
  };

  const { res, json: raw } = await tracedFetch(trace, `JSON-RPC ${method}`, agentUrl(agentId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || raw?.error) {
    const msg = raw?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(`A2A ${method} failed: ${msg}`);
  }

  const result = raw?.result ?? {};
  const task = result.task ?? result ?? {};
  return {
    taskId: task.id ?? taskId,
    taskState: task.status?.state ?? null,
    contextId: task.contextId ?? null,
    task,
    raw,
    trace: trace.toJSON(),
  };
}

/** GetTask: fetch the current state of a previously created A2A task. */
export async function getTask({ token, agentId, taskId, trace, signal }) {
  return callTaskMethod('GetTask', { token, agentId, taskId, trace, signal });
}

/**
 * CancelTask: request cancellation of an in-flight A2A task. Callers should
 * check TERMINAL_TASK_STATES against any previously known state before calling
 * this — the gateway itself may also reject an already-terminal task.
 */
export async function cancelTask({ token, agentId, taskId, trace, signal }) {
  return callTaskMethod('CancelTask', { token, agentId, taskId, trace, signal });
}

/**
 * SubscribeToTask: stream status/artifact updates for an existing task (SSE).
 * Ends when the upstream stream ends, the signal aborts, or the caller's
 * onEvent throws (e.g. after observing a terminal state) — this function
 * itself imposes no time/event caps; that's the caller's responsibility.
 * @param {{token:string, agentId?:string, taskId:string, trace?:Trace, signal?:AbortSignal, onEvent?:(evt:object)=>void}} opts
 * @returns {Promise<{taskId:string, taskState:string|null, contextId:string|null, raw:object, trace:Array}>}
 */
export async function subscribeToTask({ token, agentId, taskId, trace, signal, onEvent }) {
  trace = trace || new Trace();
  assertValidAgentId(agentId);
  const body = { jsonrpc: '2.0', id: randomUUID(), method: 'SubscribeToTask', params: { id: taskId } };

  let lastState = null;
  let lastContextId = null;
  let lastRaw = null;

  await tracedStream(
    trace,
    'JSON-RPC SubscribeToTask (SSE)',
    agentUrl(agentId),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'A2A-Version': '1.0',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
    (evt) => {
      lastRaw = evt;
      if (evt?.error) throw new Error(evt.error.message || 'A2A subscribe error');
      const result = evt?.result;
      if (!result) return;
      lastContextId = extractContextId(result) ?? lastContextId;
      lastState = extractTaskState(result) ?? lastState;
      onEvent?.(evt);
    }
  );

  return { taskId, taskState: lastState, contextId: lastContextId, raw: lastRaw, trace: trace.toJSON() };
}
