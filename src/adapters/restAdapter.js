import { Trace, tracedFetch, tracedStream } from '../trace.js';
import { attributionsToSources, referencesToSources } from '../sourceNormalizer.js';

const GATEWAY = process.env.WORKIQ_GATEWAY || 'https://workiq.svc.cloud.microsoft';
const REST_CHANNEL = (process.env.WORKIQ_REST_CHANNEL || 'ga').toLowerCase();
const REST_BASE = REST_CHANNEL === 'beta' ? `${GATEWAY}/rest/beta` : `${GATEWAY}/rest`;

export function transportInfo() {
  return {
    endpoint: REST_BASE,
    channel: REST_CHANNEL === 'beta' ? 'beta' : 'ga',
    streaming: true,
  };
}

/**
 * Complete REST's conversation setup before a coordinated comparison releases
 * the prompt-dispatch barrier. The returned calls reuse that conversation, so
 * setup remains measured but cannot give another protocol a head start.
 */
export async function prepareAsk(opts) {
  const trace = opts.trace || new Trace();
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
  const conversationId = opts.conversationId || (await createConversation(headers, trace, opts.signal));
  const preparedOpts = { ...opts, conversationId, trace };

  return {
    ask: () => ask(preparedOpts),
    askStream: ({ onEvent }) => askStream({ ...preparedOpts, onEvent }),
    cleanup: async () => {},
  };
}

/**
 * Ask Work IQ via the REST protocol (Work IQ Gateway Copilot Chat API).
 * Two steps: create a conversation (first turn), then POST the message.
 * @param {{question:string, token:string, conversationId?:string, timeZone?:string, trace?:Trace}} opts
 * @returns {Promise<{answer:string, sources:Array, conversationId:string|null, raw:object, trace:Array}>}
 */
export async function ask({
  question,
  token,
  conversationId,
  timeZone,
  location,
  files,
  webEnabled,
  additionalContext,
  trace,
  signal,
}) {
  trace = trace || new Trace();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  let convId = conversationId;
  if (convId) {
    trace.info(`Reusing existing conversation ${convId}`, { kind: 'info' });
  } else {
    convId = await createConversation(headers, trace, signal);
  }

  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const body = {
    message: { text: question },
    locationHint: { timeZone: tz, ...(location || {}) },
  };
  attachContext(body, { files, webEnabled, additionalContext, trace });

  const { res, json: raw } = await tracedFetch(
    trace,
    'POST chat message',
    `${REST_BASE}/conversations/${encodeURIComponent(convId)}/chat`,
    { method: 'POST', headers, body: JSON.stringify(body), signal }
  );

  if (!res.ok) {
    const msg = raw?.error?.message || raw?.message || `${res.status} ${res.statusText}`;
    throw new Error(`REST request failed: ${msg}`);
  }

  const messages = raw?.messages ?? [];
  const last = pickAnswerMessage(messages);
  const answer = last.text || '(no answer text returned)';
  const sources = sourcesFromMessage(last, answer);
  debugSources('REST ask', last, sources, trace);
  trace.info(`Parsed response: ${messages.length} message(s), ${sources.length} source(s)`, {
    kind: 'parse',
  });

  return { answer, sources, conversationId: raw?.id || convId || null, raw, trace: trace.toJSON() };
}

/**
 * Streaming variant: POST to /chatOverStream (SSE). The Work IQ gateway streams
 * the *cumulative* conversation state in each event, so we diff against the
 * previously seen text and emit only the new tail as a delta.
 * @param {{question, token, conversationId?, timeZone?, trace?:Trace, onEvent:Function}} opts
 */
export async function askStream({
  question,
  token,
  conversationId,
  timeZone,
  location,
  files,
  webEnabled,
  additionalContext,
  trace,
  onEvent,
  signal,
}) {
  trace = trace || new Trace();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  let convId = conversationId;
  if (convId) {
    trace.info(`Reusing existing conversation ${convId}`, { kind: 'info' });
  } else {
    convId = await createConversation(headers, trace, signal);
  }

  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const body = { message: { text: question }, locationHint: { timeZone: tz, ...(location || {}) } };
  attachContext(body, { files, webEnabled, additionalContext, trace });

  let previousText = '';
  let finalText = '';
  let lastSourceMsg = null;
  let finalSourceMsg = null;
  let lastRaw = null;

  await tracedStream(
    trace,
    'POST chatOverStream (SSE)',
    `${REST_BASE}/conversations/${encodeURIComponent(convId)}/chatOverStream`,
    { method: 'POST', headers, body: JSON.stringify(body), signal },
    (evt) => {
      lastRaw = evt;
      const messages = evt?.messages ?? [];
      let last = null;
      for (const m of messages) {
        if (typeof m.text === 'string') last = m;
        // Remember any message that carries citation data (references map or
        // attributions array), regardless of which event it arrives in.
        if (hasSourceData(m)) {
          lastSourceMsg = m;
          if (Number(evt?.turnCount) > 0) finalSourceMsg = m;
        }
      }
      if (!last) return;

      const text = last.text || '';
      if (Number(evt?.turnCount) > 0) finalText = text;

      // Cumulative stream → emit only the newly appended tail.
      if (text.startsWith(previousText)) {
        const delta = text.slice(previousText.length);
        if (delta) onEvent({ type: 'delta', text: delta });
      } else {
        onEvent({ type: 'delta', text, replace: true });
      }
      previousText = text;
    }
  );

  const answer = finalText || previousText;
  const sourceMessage = finalSourceMsg || lastSourceMsg || {};
  const sources = sourcesFromMessage(sourceMessage, answer);
  debugSources('REST askStream', sourceMessage, sources, trace);
  trace.info(`Stream complete: ${answer.length} char(s), ${sources.length} source(s)`, {
    kind: 'parse',
  });

  return {
    answer: answer || '(no answer text returned)',
    sources,
    conversationId: convId || null,
    raw: lastRaw,
    trace: trace.toJSON(),
  };
}

async function createConversation(headers, trace, signal) {
  const { res, json } = await tracedFetch(
    trace,
    'Create conversation',
    `${REST_BASE}/conversations`,
    { method: 'POST', headers, body: '{}', signal }
  );
  if (!res.ok || !json?.id) {
    const msg = json?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(`Could not create conversation: ${msg}`);
  }
  return json.id;
}

// Work IQ REST accepts OneDrive/SharePoint URIs and a per-message web toggle.
function attachContext(body, { files, webEnabled, additionalContext, trace }) {
  const uris = (files || [])
    .map((f) => (typeof f === 'string' ? f : f?.uri))
    .map((u) => (u || '').trim())
    .filter(Boolean);
  if (uris.length) {
    body.contextualResources = {
      ...(body.contextualResources || {}),
      files: uris.map((uri) => ({ uri })),
    };
    trace?.info(`Attached ${uris.length} OneDrive/SharePoint file URI(s) as context`, {
      kind: 'info',
    });
  }

  if (typeof webEnabled === 'boolean') {
    body.contextualResources = {
      ...(body.contextualResources || {}),
      webContext: { isWebEnabled: webEnabled },
    };
    trace?.info(`Web search grounding ${webEnabled ? 'enabled' : 'disabled'} for this message`, {
      kind: 'info',
    });
  }

  if (additionalContext?.length) {
    body.additionalContext = additionalContext.map(({ text, description }) => ({
      text,
      ...(description ? { description } : {}),
    }));
    trace?.info(`Attached ${additionalContext.length} additional text context block(s)`, {
      kind: 'info',
    });
  }
}

// Build ordered sources from a response message, supporting BOTH documented
// shapes:
//   • references — a keyed map { "1": { targetLink, isCitedInResponse }, … }
//     (newer Work IQ format; keys correspond to the [n] citation numbers).
//   • attributions — an array [{ attributionType, seeMoreWebUrl, … }] (older).
// References take precedence when present. Sources stay compact and retain the
// response reference ID so opaque numeric IDs never create sparse arrays.
function sourcesFromMessage(message, answer) {
  const fromRefs = referencesToSources(message?.references, answer);
  if (fromRefs.length) return fromRefs;
  return attributionsToSources(message?.attributions ?? [], answer);
}

function hasSourceData(m) {
  if (!m || typeof m !== 'object') return false;
  if (Array.isArray(m.attributions) && m.attributions.length) return true;
  const refs = m.references;
  if (refs && typeof refs === 'object') {
    return Object.keys(refs).some((k) => k !== '@odata.type');
  }
  return false;
}

// Emit a lightweight diagnostic into the trace so the "Behind the scenes" panel
// shows which citation format the live response used and how many sources had a
// clickable URL — handy for this testing tool.
function debugSources(label, message, sources, trace) {
  try {
    const refKeys =
      message?.references && typeof message.references === 'object'
        ? Object.keys(message.references).filter((k) => k !== '@odata.type').length
        : 0;
    const attrs = Array.isArray(message?.attributions) ? message.attributions.length : 0;
    const withUrl = sources.filter((s) => s.url).length;
    const fmt = refKeys ? 'references map' : attrs ? 'attributions array' : 'none';
    trace?.info(
      `Citations: ${fmt} — ${withUrl}/${sources.length} link to a source (refs:${refKeys} attrs:${attrs})`,
      { kind: 'parse' }
    );
  } catch {
    /* ignore */
  }
}

// Pick the assistant answer message (the longest-text message; the user echo is
// short and has no sources).
function pickAnswerMessage(messages) {
  if (!Array.isArray(messages) || !messages.length) return {};
  const withSource = messages.filter(hasSourceData);
  if (withSource.length) return withSource[withSource.length - 1];
  let best = messages[messages.length - 1];
  for (const m of messages) {
    if (typeof m.text === 'string' && (m.text.length > (best.text?.length || 0))) best = m;
  }
  return best || {};
}
