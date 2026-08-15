import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
import { Trace } from '../trace.js';

// Work IQ offers MCP two ways:
//   • remote  — MCP-over-HTTP at the Work IQ gateway, authenticated with the SAME
//               delegated Entra token as REST/A2A (no CLI, no separate sign-in).
//   • local   — the @microsoft/workiq CLI run as a stdio subprocess; the CLI does
//               its own browser sign-in and has its own EULA gate.
// Default to remote so MCP is a true "via API" path consistent with REST/A2A.
const TRANSPORT = (process.env.WORKIQ_MCP_TRANSPORT || 'remote').toLowerCase();
const REMOTE_MCP_URL = process.env.WORKIQ_MCP_URL || 'https://workiq.svc.cloud.microsoft/mcp';
const require = createRequire(import.meta.url);
const MCP_CLI_PATH = require.resolve('@microsoft/workiq/bin/workiq.js');
const REMOTE_FALLBACK = (process.env.WORKIQ_MCP_REMOTE_FALLBACK || 'off').toLowerCase();
const ACCEPT_EULA = process.env.WORKIQ_MCP_ACCEPT_EULA === 'true';
if (!new Set(['remote', 'local']).has(TRANSPORT)) {
  throw new Error('WORKIQ_MCP_TRANSPORT must be remote or local.');
}
if (REMOTE_FALLBACK !== 'off') {
  throw new Error(
    'WORKIQ_MCP_REMOTE_FALLBACK must be off. Automatic fallback can substitute a different signed-in identity.'
  );
}

/** True when the active transport needs the app's delegated token (remote). */
export function requiresToken() {
  return TRANSPORT === 'remote';
}

/** Human-readable description of the active MCP transport (for the UI/trace). */
export function transportInfo() {
  if (TRANSPORT === 'remote') {
    return { transport: 'remote', detail: `MCP over HTTP — ${REMOTE_MCP_URL} (delegated Entra token)` };
  }
  return { transport: 'local', detail: 'local CLI — locked @microsoft/workiq package (self sign-in)' };
}

let clientPromise = null; // cached LOCAL subprocess client only
let toolsCache = null;

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function waitForAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function newClient() {
  return new Client({ name: 'workiq-api-tester', version: '1.0.0' }, { capabilities: {} });
}

// Classify a remote-connect failure so callers can decide to redirect to sign-in,
// fall back to local, or surface a clear message.
function classifyRemoteError(e) {
  const msg = e?.message || '';
  if (e?.code === 401 || /401|unauthor/i.test(msg)) {
    e.needsLogin = true;
  } else if (/tenant_not_allowed/i.test(msg) || (e?.code === 403 && /not authorized|not allowed/i.test(msg))) {
    e.tenantNotAllowed = true;
    e.shortReason = 'tenant not enabled for remote MCP';
  } else if (e?.code === 403 || e?.code === 404) {
    e.remoteUnavailable = true;
    e.shortReason = `remote MCP returned HTTP ${e.code}`;
  }
  return e;
}

async function connectRemote(client, transport) {
  try {
    await client.connect(transport);
  } catch (e) {
    throw classifyRemoteError(e);
  }
}

// Open the LOCAL stdio (subprocess) MCP client. Cached and reused.
async function openLocal({ trace, signal } = {}) {
  const client = await waitForAbort(getClient(trace), signal);
  return { client, tools: toolsCache ?? [], cleanup: async () => {} };
}

// Try the REMOTE HTTP MCP endpoint with a fresh per-call client carrying the token.
async function openRemote({ token, trace, inspectOnly = false, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const transport = new StreamableHTTPClientTransport(new URL(REMOTE_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = newClient();
  const closeOnAbort = () => {
    void Promise.resolve(client.close()).catch(() => {});
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  const connectAndList = async (step) => {
    await connectRemote(client, transport);
    const { tools } = await client.listTools();
    if (step) step.detail = { transport: 'streamable-http', url: REMOTE_MCP_URL, toolsDiscovered: tools.map((t) => t.name) };
    return tools;
  };
  try {
    const tools = trace
      ? await trace.measure('Connect remote MCP (HTTP)', 'process', (step) =>
          waitForAbort(connectAndList(step), signal)
        )
      : await waitForAbort(connectAndList(), signal);
    return {
      client,
      tools,
      transportUsed: 'remote',
      cleanup: async () => {
        try {
          await client.close();
        } catch {
          /* the connection may already be closed */
        }
      },
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* the client may not have finished connecting */
    }
    if (signal?.aborted) throw abortError();
    throw classifyRemoteError(error);
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
  }
}

// Open an MCP client for the active transport. For remote, a fresh HTTP client is
// created per call (carrying the current token); for local, the cached subprocess
// client is reused. Returns { client, tools, transportUsed, cleanup }.
export async function openClient({ token, trace, inspectOnly = false, signal } = {}) {
  if (TRANSPORT === 'remote') {
    if (!token) {
      const e = new Error('Remote MCP requires sign-in.');
      e.needsLogin = true;
      throw e;
    }
    try {
      return await openRemote({ token, trace, inspectOnly, signal });
    } catch (e) {
      if (e.tenantNotAllowed) {
        e.userMessage =
          'Work IQ\u2019s remote MCP endpoint is not enabled for your tenant (tenant_not_allowed). ' +
          'REST and A2A still work. To use MCP, run it via the local CLI: set WORKIQ_MCP_TRANSPORT=local and restart.';
      }
      throw e;
    }
  }

  // Local stdio transport (cached subprocess).
  return inspectOnly ? openLocalInspection({ trace }) : openLocal({ trace, signal });
}

async function openLocalInspection({ trace } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_CLI_PATH, 'mcp'],
  });
  const client = newClient();
  const connectAndList = async (step) => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (step) {
      step.detail = {
        transport: 'stdio',
        package: '@microsoft/workiq',
        toolsDiscovered: tools.map((tool) => tool.name),
        inspectionOnly: true,
      };
    }
    return tools;
  };
  try {
    const tools = trace
      ? await trace.measure('Inspect local MCP server (@microsoft/workiq mcp)', 'process', connectAndList)
      : await connectAndList();
    return {
      client,
      tools,
      transportUsed: 'local',
      cleanup: async () => {
        try {
          await client.close();
        } catch {
          /* the subprocess may already have exited */
        }
      },
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* the subprocess may not have finished starting */
    }
    throw error;
  }
}

async function getClient(trace) {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CLI_PATH, 'mcp'],
    });
    const client = newClient();
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      toolsCache = tools;
      await acceptEulaIfNeeded(client, tools);
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch {
        /* the subprocess may not have finished starting */
      }
      throw error;
    }
  })();
  try {
    if (trace) {
      await trace.measure('Start local MCP server (@microsoft/workiq mcp)', 'process', async (step) => {
        const client = await clientPromise;
        step.detail = { transport: 'stdio', package: '@microsoft/workiq', toolsDiscovered: (toolsCache ?? []).map((t) => t.name) };
        return client;
      });
    }
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    toolsCache = null;
    throw error;
  }
}

// The Work IQ MCP server can require EULA acceptance before other tools work.
// Acceptance is explicit because it records consent on the operator's behalf.
async function acceptEulaIfNeeded(client, tools) {
  const tool = (tools ?? []).find((t) => /accept.?eula/i.test(t.name));
  if (!tool) return;
  if (!ACCEPT_EULA) {
    const error = new Error(
      'Local MCP requires explicit Work IQ EULA acceptance. Review the terms, set WORKIQ_MCP_ACCEPT_EULA=true, and restart.'
    );
    error.userMessage = error.message;
    throw error;
  }
  const props = tool.inputSchema?.properties || {};
  const args = {};
  for (const [key, definition] of Object.entries(props)) {
    if (definition?.type === 'boolean' || /accept|agree|eula|consent/i.test(key)) args[key] = true;
  }
  await client.callTool({ name: tool.name, arguments: args });
}

function pickAskTool(tools) {
  if (!tools?.length) return null;
  const byName = (re) => tools.find((t) => re.test(t.name));
  return (
    byName(/^ask$/i) ||
    byName(/ask/i) ||
    byName(/query/i) ||
    byName(/search/i) ||
    tools[0]
  );
}

function buildArgs(tool, question, extra = {}) {
  const props = tool.inputSchema?.properties || {};
  const keys = Object.keys(props);
  const preferred = ['question', 'query', 'prompt', 'q', 'input', 'text', 'message'];
  const key = preferred.find((k) => keys.includes(k)) || keys[0] || 'question';
  const args = { [key]: question };
  // The Work IQ "ask" tool also accepts agentId / fileUrls / conversationId / timeZone.
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '' && keys.includes(k)) args[k] = v;
  }
  return args;
}

function extractText(result) {
  const parts = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text' && item.text) parts.push(item.text);
  }
  return parts.join('\n') || '(no answer text returned)';
}

// Remote MCP returns { answer, conversationId } as structuredContent while the
// local CLI can return the same payload as JSON-encoded text. Normalize both.
export function answerFromToolResult(result) {
  const parsed = parseToolJson(result);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const text = parsed.response ?? parsed.answer ?? parsed.text ?? parsed.message;
    if (typeof text === 'string') {
      return {
        text,
        conversationId: parsed.conversationId ?? parsed.conversation_id ?? null,
      };
    }
  }
  return { text: typeof parsed === 'string' ? parsed : extractText(result), conversationId: null };
}

// Work IQ's agentic "ask" can take well over the MCP SDK's default 60s request
// timeout. Allow a longer per-call timeout (configurable) and reset it whenever
// the server reports progress, capped by a hard maximum.
const ASK_TIMEOUT_MS = Number(process.env.WORKIQ_MCP_TIMEOUT_MS || 180000);

/**
 * Ask Work IQ via MCP (remote HTTP by default, or local CLI).
 * @param {{question:string, token?:string, agentId?:string, files?:Array, conversationId?:string, timeZone?:string, trace?:Trace}} opts
 * @returns {Promise<{answer:string, sources:Array, sourcesStatus:string, conversationId:string|null, raw:object, toolUsed:string, trace:Array}>}
 */
function normalizeAskResult({ result, tool, transportUsed, trace }) {
  if (result?.isError) {
    throw new Error('MCP tool returned an error: ' + extractText(result));
  }

  const { text, conversationId } = answerFromToolResult(result);
  return {
    answer: text,
    sources: [],
    sourcesStatus: 'unavailable',
    sourceNote: 'The Work IQ MCP ask response exposes response text and conversationId, but no structured citations.',
    conversationId,
    toolUsed: tool.name,
    transportUsed,
    raw: result,
    trace: trace.toJSON(),
  };
}

/**
 * Connect and discover the Work IQ MCP tool before a comparison dispatches its
 * prompt. The actual tools/call stays behind the shared dispatch barrier.
 */
export async function prepareAsk(opts) {
  const trace = opts.trace || new Trace();
  const { client, tools, transportUsed, cleanup } = await openClient({
    token: opts.token,
    trace,
    signal: opts.signal,
  });
  const tool = pickAskTool(tools);
  if (!tool) {
    await cleanup();
    throw new Error('Work IQ MCP server exposed no tools.');
  }
  const fileUrls = (opts.files || [])
    .map((file) => (typeof file === 'string' ? file : file?.uri))
    .filter(Boolean);
  const args = buildArgs(tool, opts.question, {
    agentId: opts.agentId || undefined,
    fileUrls: fileUrls.length ? fileUrls : undefined,
    conversationId: opts.conversationId || undefined,
    timeZone: opts.timeZone || undefined,
  });

  return {
    ask: async () => {
      const result = await callOpenTool(client, tool.name, args, trace, opts.signal);
      return normalizeAskResult({ result, tool, transportUsed, trace });
    },
    cleanup,
  };
}

export async function ask(opts) {
  const prepared = await prepareAsk(opts);
  try {
    return await prepared.ask();
  } finally {
    await prepared.cleanup();
  }
}

function parseToolJson(result) {
  // Work IQ raw tools return their payload either as structuredContent or as a
  // JSON string inside a text content item.
  if (result?.structuredContent != null) return result.structuredContent;
  for (const item of result?.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
  }
  return null;
}

/**
 * List the agents available to the "ask" tool (built-in Copilot + any installed
 * agents the user can reach). Returns [{ agentId, name, provider }].
 */
export async function listAgents({ token, trace } = {}) {
  trace = trace || new Trace();
  const { client, tools, cleanup } = await openClient({ token, trace });
  try {
    const tool = (tools ?? []).find((t) => /^list_agents?$/i.test(t.name));
    if (!tool) throw new Error('The Work IQ MCP server does not expose a "list_agents" tool.');
    const result = await trace.measure(`Call MCP tool "${tool.name}"`, 'tool', async (step) => {
      step.request = { tool: tool.name, arguments: {} };
      const r = await client.callTool({ name: tool.name, arguments: {} });
      step.response = r;
      step.ok = !r?.isError;
      return r;
    });
    if (result?.isError) throw new Error('list_agents returned an error: ' + extractText(result));
    const data = parseToolJson(result);
    const agents = Array.isArray(data) ? data : Array.isArray(data?.value) ? data.value : [];
    return { agents, raw: result, trace: trace.toJSON() };
  } finally {
    await cleanup();
  }
}

export async function listTools({ token, trace } = {}) {
  const { tools, cleanup } = await openClient({ token, trace });
  try {
    return tools ?? [];
  } finally {
    await cleanup();
  }
}

/**
 * Discover the MCP server's tool surface for capability inspection, returning
 * only safe metadata (name, description, JSON-Schema for inputs) — never calls
 * any tool, so this never triggers a billable Work IQ "ask".
 * @returns {Promise<{tools:Array<{name:string, description:string|null, inputSchema:object|null}>, trace:Array}>}
 */
export async function inspectTools({ token, trace } = {}) {
  trace = trace || new Trace();
  const { tools, cleanup } = await openClient({ token, trace, inspectOnly: true });
  try {
    const safeTools = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
    }));
    return { tools: safeTools, trace: trace.toJSON() };
  } finally {
    await cleanup();
  }
}

/**
 * Directly invoke a single MCP tool by name with caller-supplied arguments.
 * This bypasses the agentic "ask" wrapper so the raw tool surface (fetch,
 * search_paths, call_function, get_schema, create/update/delete_entity,
 * do_action, list_agents) can be exercised for testing.
 * @returns {Promise<{tool:string, isError:boolean, structured:any, text:string, raw:object, transportUsed:string, trace:Array}>}
 */
export async function callTool({ name, args = {}, token, trace }) {
  trace = trace || new Trace();
  if (!name) throw new Error('A tool name is required.');
  const { client, tools, transportUsed, cleanup } = await openClient({ token, trace });
  try {
    const tool = (tools ?? []).find((t) => t.name === name);
    if (!tool) {
      const available = (tools ?? []).map((t) => t.name).join(', ');
      throw new Error(`Tool "${name}" is not available. Exposed tools: ${available || '(none)'}`);
    }
    const result = await trace.measure(`Call MCP tool "${name}"`, 'tool', async (step) => {
      step.request = { tool: name, arguments: args };
      const r = await client.callTool({ name, arguments: args }, undefined, {
        timeout: ASK_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: ASK_TIMEOUT_MS,
      });
      step.response = r;
      step.ok = !r?.isError;
      return r;
    });
    return {
      tool: name,
      isError: Boolean(result?.isError),
      structured: result?.structuredContent ?? parseToolJson(result),
      text: extractText(result),
      raw: result,
      transportUsed,
      trace: trace.toJSON(),
    };
  } finally {
    await cleanup();
  }
}

// ── Helpers shared with the LLM agent adapter ──────────────────────────────

/** The configurable per-tool-call timeout (ms). */
export function askTimeoutMs() {
  return ASK_TIMEOUT_MS;
}

/** Extract the joined text content of a tool result (re-exported for the agent). */
export function toolText(result) {
  return extractText(result);
}

/** Parse a tool result's JSON payload (structuredContent or JSON-in-text). */
export function toolJson(result) {
  return parseToolJson(result);
}

/**
 * Convert a Work IQ MCP tool's JSON-Schema into an OpenAI function-tool definition.
 * Returns { type:'function', function:{ name, description, parameters } }.
 */
export function toolToFunctionDef(tool, { namePrefix = '' } = {}) {
  const parameters =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: `${namePrefix}${tool.name}`,
      description: tool.description || `Work IQ MCP tool "${tool.name}".`,
      parameters,
    },
  };
}

/**
 * Invoke a tool on an already-open MCP client, with the standard long timeout and
 * progress-reset behaviour. Returns the raw MCP result.
 */
export async function callOpenTool(client, name, args, trace, signal) {
  const run = async (step) => {
    if (step) step.request = { tool: name, arguments: args };
    trace?.protocolEvent('sdk_request', `Call MCP tool "${name}"`, {
      layer: 'sdk',
      operation: 'tools/call',
      tool: name,
      arguments: args,
    });
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, {
        timeout: ASK_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: ASK_TIMEOUT_MS,
        signal,
      });
      if (step) {
        step.response = r;
        step.ok = !r?.isError;
      }
      trace?.protocolEvent('sdk_response', `MCP tool "${name}" result`, {
        layer: 'sdk',
        operation: 'tools/call',
        tool: name,
        result: r,
      });
      return r;
    } catch (error) {
      trace?.protocolEvent('sdk_error', `MCP tool "${name}" failed`, {
        layer: 'sdk',
        operation: 'tools/call',
        tool: name,
        error: error?.message || String(error),
      });
      throw error;
    }
  };
  if (trace) return trace.measure(`Call MCP tool "${name}"`, 'tool', run);
  return run(null);
}

export async function shutdown() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    /* ignore */
  }
  clientPromise = null;
  toolsCache = null;
}
