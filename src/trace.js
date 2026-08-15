// Lightweight execution tracing so the UI can show the "behind the scenes" steps
// (HTTP calls, auth, parsing) for a single ask. Sensitive values are redacted.
//
// Traces can optionally carry a bounded "protocol event sink" — a live feed of
// redacted request/response/stream events suitable for a raw-protocol inspector
// (e.g. the experiment workbench). The sink is opt-in (constructed with an
// `onEvent` callback) so ordinary Trace usage is unaffected.

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);
const HTTP_TIMEOUT_MS = Number(process.env.WORKIQ_HTTP_TIMEOUT_MS || 120_000);

// Sensitive keys redacted anywhere they appear in a sink event payload, however
// deeply nested. Names are compared case-insensitively with '-'/' ' folded to '_'
// so "Access-Token", "access token", and "access_token" all match.
const SINK_SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set_cookie',
  'access_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'subscription_key',
  'password',
  'token',
  'secret',
]);

const SINK_MAX_EVENT_BYTES = 64 * 1024; // cap each emitted sink payload at 64 KiB
const SINK_MAX_EVENTS = 500; // cap total events retained/emitted per trace
const SINK_MAX_TOTAL_BYTES = 2 * 1024 * 1024; // cap total bytes retained/emitted per trace

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      const s = String(v);
      const prefix = s.split(' ')[0];
      out[k] = prefix && prefix !== s ? `${prefix} <redacted>` : '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeKeyName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function isSensitiveSinkKey(key) {
  const normalized = normalizeKeyName(key);
  return SINK_SENSITIVE_KEYS.has(normalized) || /(?:^|_)(?:token|secret)$/.test(normalized);
}

function redactSinkScalar() {
  return '<redacted>';
}

// Recursively redact sensitive keys anywhere in an arbitrary payload (request
// bodies, response bodies, headers-as-objects, streamed SSE data, ...).
function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (depth > 25) return '[max depth reached]';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveSinkKey(k) ? redactSinkScalar(v) : redactDeep(v, depth + 1, seen);
    }
    return out;
  }
  return value;
}

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

// Serialize + cap a payload at maxBytes. If it doesn't fit, replace it with a
// truncated preview and explicit truncation metadata rather than dropping it.
function capPayload(value, maxBytes) {
  let json;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    json = JSON.stringify(String(value));
  }
  const originalBytes = byteLength(json);
  if (originalBytes <= maxBytes) {
    return { payload: value, truncated: false, bytes: originalBytes };
  }

  const buildTruncatedPayload = (preview) => ({ _truncated: true, preview, originalBytes, maxBytes });
  let low = 0;
  let high = Math.min(json.length, maxBytes);
  let truncatedPayload = buildTruncatedPayload('');
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = buildTruncatedPayload(json.slice(0, midpoint));
    if (byteLength(JSON.stringify(candidate)) <= maxBytes) {
      truncatedPayload = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return { payload: truncatedPayload, truncated: true, bytes: byteLength(JSON.stringify(truncatedPayload)) };
}

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  for (const [k, v] of h.entries()) out[k] = v;
  return redactHeaders(out);
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function combineFetchSignal(callerSignal, timeoutMs = HTTP_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

export class Trace {
  // `onEvent`, when provided, activates the bounded protocol-event sink: a live
  // feed of redacted request/response/stream-data/completion/error events (for
  // e.g. a raw-protocol inspector). `onStep` is a separate metadata-only feed
  // for the live lab: it never includes URLs, headers, bodies, IDs, or errors.
  constructor({ onEvent, onStep } = {}) {
    this.t0 = Date.now();
    this.steps = [];
    this._onEvent = typeof onEvent === 'function' ? onEvent : null;
    this._onStep = typeof onStep === 'function' ? onStep : null;
    this.sinkEnabled = Boolean(this._onEvent);
    this.sinkEvents = [];
    this._sinkSeq = 0;
    this._sinkBytes = 0;
    this._sinkEventCount = 0;
    this._sinkCapReached = false;
  }

  _add(step) {
    const full = { startMs: Date.now() - this.t0, durationMs: 0, ok: true, ...step };
    Object.defineProperty(full, '_liveStepId', { value: this.steps.length });
    this.steps.push(full);
    return full;
  }

  _emitStep(step, state) {
    if (!this._onStep) return;
    const rawTitle = String(step.title || 'Operation');
    const title = rawTitle
      .replace(/^Reusing existing conversation(?:\s+\S+)?$/i, 'Reuse existing conversation')
      .replace(/Continuing conversation \(contextId [^)]+\)/gi, 'Continue existing conversation')
      .slice(0, 160);
    const event = {
      id: step._liveStepId,
      state,
      kind: String(step.kind || 'info').slice(0, 32),
      title,
      startMs: step.startMs,
      durationMs: step.durationMs,
    };
    if (Number.isInteger(step.response?.status)) event.status = step.response.status;
    this._onStep(event);
  }

  // Push a protocol event into the bounded sink (no-op unless the sink is
  // enabled). Payloads are recursively redacted and size-capped; once the
  // per-trace event count or byte budget is exhausted, a single explicit
  // truncation event is emitted and further events are silently dropped —
  // the underlying operation itself is never affected.
  _emitSink(kind, title, data) {
    if (!this.sinkEnabled || this._sinkCapReached) return;

    const eventBase = {
      seq: this._sinkSeq,
      ts: Date.now() - this.t0,
      kind: String(kind).slice(0, 64),
      title: String(title).slice(0, 512),
      data: null,
      truncated: false,
    };
    const eventOverheadBytes = byteLength(JSON.stringify(eventBase)) - byteLength('null');
    const { payload, truncated } = capPayload(
      redactDeep(data),
      Math.max(1, SINK_MAX_EVENT_BYTES - eventOverheadBytes)
    );
    const event = { ...eventBase, seq: this._sinkSeq++, data: payload, truncated };
    const eventBytes = byteLength(JSON.stringify(event));

    if (this._sinkEventCount + 1 > SINK_MAX_EVENTS || this._sinkBytes + eventBytes > SINK_MAX_TOTAL_BYTES) {
      this._sinkCapReached = true;
      const notice = {
        seq: event.seq,
        ts: Date.now() - this.t0,
        kind: 'truncated',
        title: 'Protocol event stream truncated',
        reason: this._sinkEventCount + 1 > SINK_MAX_EVENTS ? 'max_events' : 'max_bytes',
        emittedEvents: this._sinkEventCount,
        emittedBytes: this._sinkBytes,
        limits: {
          maxEvents: SINK_MAX_EVENTS,
          maxTotalBytes: SINK_MAX_TOTAL_BYTES,
          maxEventBytes: SINK_MAX_EVENT_BYTES,
        },
      };
      this.sinkEvents.push(notice);
      this._sinkEventCount += 1;
      this._onEvent(notice);
      return;
    }

    this.sinkEvents.push(event);
    this._sinkEventCount += 1;
    this._sinkBytes += eventBytes;
    this._onEvent(event);
  }

  protocolEvent(kind, title, data) {
    this._emitSink(kind, title, data);
  }

  // A non-HTTP informational step (auth, parsing, spawning a process, etc.).
  info(title, { kind = 'info', detail = null } = {}) {
    const step = this._add({ title, kind, detail, durationMs: 0 });
    this._emitStep(step, 'running');
    this._emitStep(step, 'complete');
    return step;
  }

  // Wrap a sync/async piece of work and record how long it took.
  async measure(title, kind, fn) {
    const started = Date.now();
    const step = this._add({ title, kind });
    this._emitStep(step, 'running');
    try {
      const result = await fn(step);
      step.durationMs = Date.now() - started;
      this._emitStep(step, 'complete');
      return result;
    } catch (e) {
      step.durationMs = Date.now() - started;
      step.ok = false;
      step.error = e.message;
      this._emitStep(step, 'error');
      throw e;
    }
  }

  toJSON() {
    return this.steps;
  }
}

/**
 * Perform a fetch while recording the request and response into the trace.
 * Returns { res, json, text }.
 */
export async function tracedFetch(trace, title, url, options = {}) {
  const started = Date.now();
  const requestPayload = {
    method: options.method || 'GET',
    url,
    headers: redactHeaders(options.headers || {}),
    body: safeParse(options.body) ?? options.body ?? null,
  };
  const step = trace ? trace._add({ title, kind: 'http', request: requestPayload }) : null;
  if (step) trace._emitStep(step, 'running');
  trace?._emitSink('request', title, requestPayload);

  try {
    const fetchOptions = { ...options, signal: combineFetchSignal(options.signal) };
    const res = await fetch(url, fetchOptions);
    const text = await res.text();
    const json = safeParse(text);
    const responsePayload = {
      status: res.status,
      statusText: res.statusText,
      headers: headersToObject(res.headers),
      body: json ?? text ?? null,
    };
    if (step) {
      step.durationMs = Date.now() - started;
      step.ok = res.ok;
      step.response = responsePayload;
      trace._emitStep(step, res.ok ? 'complete' : 'error');
    }
    trace?._emitSink('response', title, responsePayload);
    return { res, json, text };
  } catch (e) {
    if (step) {
      step.durationMs = Date.now() - started;
      step.ok = false;
      step.error = e.message;
      trace._emitStep(step, 'error');
    }
    trace?._emitSink('error', title, { error: e.message });
    throw e;
  }
}

/**
 * Perform a fetch that returns Server-Sent Events, recording the request and a
 * summary of the streamed response into the trace. Calls onEvent(parsedJson)
 * for each `data:` line. Returns { res, eventCount }.
 */
export async function tracedStream(trace, title, url, options = {}, onEvent = () => {}) {
  const started = Date.now();
  const requestPayload = {
    method: options.method || 'GET',
    url,
    headers: redactHeaders(options.headers || {}),
    body: safeParse(options.body) ?? options.body ?? null,
  };
  const step = trace ? trace._add({ title, kind: 'http', request: requestPayload }) : null;
  if (step) trace._emitStep(step, 'running');
  trace?._emitSink('request', title, requestPayload);

  let res;
  try {
    const fetchOptions = { ...options, signal: combineFetchSignal(options.signal) };
    res = await fetch(url, fetchOptions);
  } catch (e) {
    if (step) {
      step.durationMs = Date.now() - started;
      step.ok = false;
      step.error = e.message;
      trace._emitStep(step, 'error');
    }
    trace?._emitSink('error', title, { error: e.message });
    throw e;
  }

  if (!res.ok) {
    const text = await res.text();
    const json = safeParse(text);
    const responsePayload = {
      status: res.status,
      statusText: res.statusText,
      headers: headersToObject(res.headers),
      body: json ?? text ?? null,
    };
    if (step) {
      step.durationMs = Date.now() - started;
      step.ok = false;
      step.response = responsePayload;
      trace._emitStep(step, 'error');
    }
    trace?._emitSink('response', title, responsePayload);
    const err = new Error(json?.error?.message || json?.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }

  trace?._emitSink('response_headers', title, {
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        const json = safeParse(dataStr);
        if (json !== null) {
          eventCount += 1;
          trace?._emitSink('data', title, json);
          onEvent(json);
        }
      }
    }
  } catch (e) {
    if (step) {
      step.durationMs = Date.now() - started;
      step.ok = false;
      step.error = e.message;
    }
    trace?._emitSink('error', title, { error: e.message });
    throw e;
  }

  if (step) {
    step.durationMs = Date.now() - started;
    step.ok = true;
    step.response = {
      status: res.status,
      statusText: res.statusText,
      headers: headersToObject(res.headers),
      body: `‹streamed ${eventCount} SSE event(s)›`,
    };
    trace._emitStep(step, 'complete');
  }
  trace?._emitSink('complete', title, { eventCount, durationMs: Date.now() - started });
  return { res, eventCount };
}
