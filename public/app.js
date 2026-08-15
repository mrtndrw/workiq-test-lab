const HINTS = {
  rest: 'REST · /rest/conversations route · conversational JSON or SSE · delegated WorkIQAgent.Ask token.',
  a2a: 'A2A · JSON-RPC SendMessage or SendStreamingMessage · v1.0 selected by header · delegated WorkIQAgent.Ask token.',
  mcp: 'MCP · one direct Work IQ ask tool call over remote HTTP or the local Work IQ CLI · delegated user context.',
};

let mode = 'rest';
let view = 'agent'; // 'agent' (LLM orchestrates) | 'direct' (raw protocol)
let callerSelectionExplicit = false;
const agentBackends = new Set(['mcp']); // which Work IQ backends the agent may use
let currentModel = 'gpt-5.2';
let llmConfig = null;
let defaultSystemPrompt = '';
let currentSystemPrompt = '';
let labConfig = null;
const conversationIds = { rest: null, a2a: null, mcp: null };
const agentConversationIds = { rest: null, a2a: null, mcp: null };
const agentHistory = []; // [{role, content}] for multi-turn agent chat
const conversationTurns = { rest: 0, a2a: 0, mcp: 0, llm: 0 };
const REQUEST_TIMEOUT_MS = 120_000;
let requestInFlight = false;
let activeContinuation = null;
let activeRequestController = null;
let activeRequestTimeout = null;
let requestAbortReason = null;
let discoveredAgents = null;
let agentDiscoveryPromise = null;
let agentDiscoveryAttempted = false;
let mcpToolNames = null;
let mcpToolDiscoveryPromise = null;
let mcpToolDiscoveryError = '';
let contextPanelCollapsed = false;
let activeAssistantBubble = null;
const thinkingTimers = new WeakMap();
let responseStreamingPreference = true;

const $ = (id) => document.getElementById(id);

window.workIqLabState = {
  snapshot() {
    return {
      view,
      mode,
      selectedAgentId: $('agentId')?.value.trim() || '',
      conversationIds: { ...conversationIds },
      agentConversationIds: { ...agentConversationIds },
      discoveredAgents: (discoveredAgents || []).map((agent) => ({ ...agent })),
      agentDiscoveryAttempted,
      mcpToolNames: mcpToolNames ? [...mcpToolNames] : null,
    };
  },
  discoverAgents(options) {
    return loadAgents(options);
  },
};

function agentHint() {
  const backs = orderedAgentBackends().map((b) => b.toUpperCase()).join(' + ') || 'no backend';
  const liveStreams = orderedAgentBackends()
    .filter((backend) => backend === 'rest' || backend === 'a2a')
    .map((backend) => backend.toUpperCase())
    .join(' + ');
  const streaming = liveStreams
    ? `Azure OpenAI + ${liveStreams} stream live`
    : 'Azure OpenAI streams; MCP returns one tool result';
  return `Agent orchestrated · ${currentModel} on your Azure tenant · Work IQ connections: ${backs} · ${streaming}.`;
}

function orderedAgentBackends() {
  return ['rest', 'a2a', 'mcp'].filter((backend) => agentBackends.has(backend));
}

function composerSupportsContext() {
  return view === 'agent' ? agentBackends.has('rest') || agentBackends.has('mcp') : mode !== 'a2a';
}

function syncComposerContext() {
  const available = composerSupportsContext();
  const toggle = $('contextToggle');
  const panel = $('attach');
  toggle?.classList.toggle('hidden', !available);
  toggle?.setAttribute('aria-expanded', String(available && !contextPanelCollapsed));
  panel?.classList.toggle('hidden', !available || contextPanelCollapsed);
}

function routeUsesMcp() {
  return view === 'agent' ? agentBackends.has('mcp') : mode === 'mcp';
}

function renderMcpToolSurface() {
  const card = $('mcpToolSurface');
  const list = $('mcpToolList');
  const count = $('mcpToolCount');
  if (!card || !list || !count) return;

  const active = routeUsesMcp();
  card.classList.toggle('hidden', !active);
  if (!active) return;

  if (mcpToolDiscoveryError) {
    count.textContent = 'Unavailable';
    list.innerHTML = `<div class="log-step error"><strong>Tool discovery failed</strong><span>MCP</span><small>${escapeHtml(
      mcpToolDiscoveryError
    )}</small></div>`;
    return;
  }
  if (!mcpToolNames) {
    count.textContent = 'Loading metadata…';
    list.innerHTML = '<p>Discovering the current MCP tool surface…</p>';
    return;
  }

  count.textContent = `${mcpToolNames.length} tool${mcpToolNames.length === 1 ? '' : 's'}`;
  list.innerHTML = mcpToolNames.length
    ? mcpToolNames
        .map(
          (name) =>
            `<div class="log-step"><strong>${escapeHtml(name)}</strong><span>MCP</span></div>`
        )
        .join('')
    : '<p>The active MCP server exposed no tools.</p>';
}

async function loadMcpToolSurface({ force = false } = {}) {
  if (!routeUsesMcp()) {
    renderMcpToolSurface();
    return;
  }
  if (mcpToolNames && !force) {
    renderMcpToolSurface();
    return;
  }
  if (mcpToolDiscoveryPromise) return mcpToolDiscoveryPromise;

  mcpToolDiscoveryError = '';
  if (force) mcpToolNames = null;
  renderMcpToolSurface();
  mcpToolDiscoveryPromise = (async () => {
    try {
      const response = await fetch('/api/lab/capabilities');
      const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      if (data.runtime?.error) throw new Error(data.runtime.error);
      if (!Array.isArray(data.runtime?.toolNames)) {
        throw new Error('The capability response did not include MCP tool metadata.');
      }
      mcpToolNames = [...new Set(data.runtime.toolNames.map((name) => String(name)))].sort();
    } catch (error) {
      mcpToolNames = null;
      mcpToolDiscoveryError = error.message;
    } finally {
      mcpToolDiscoveryPromise = null;
      renderMcpToolSurface();
    }
  })();
  return mcpToolDiscoveryPromise;
}

function syncMcpToolSurface() {
  renderMcpToolSurface();
  if (routeUsesMcp()) void loadMcpToolSurface();
}

function updatePromptRouteChip() {
  const chip = $('promptRouteChip');
  if (!chip) return;
  const route = view === 'agent'
    ? `Agent · ${orderedAgentBackends().map((backend) => backend.toUpperCase()).join('+')}`
    : `Direct · ${mode.toUpperCase()}`;
  const label = chip.querySelector('span');
  if (label) label.textContent = route;
  chip.setAttribute('aria-label', `Current request route: ${route}`);
}

// ── View switch: Agent (LLM) vs Direct (raw protocol) ───────────────────────
function setView(next, { explicit = false } = {}) {
  if (explicit) callerSelectionExplicit = true;
  if (next === 'agent') setAgentRouteNotice('');
  view = next;
  document.querySelectorAll('.view').forEach((b) => {
    const active = b.dataset.view === next;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const modes = document.querySelector('.modes');
  const label = $('modesLabel');

  if (next === 'agent') {
    modes.classList.add('multi');
    modes.setAttribute('aria-label', 'Available Work IQ connections; choose one or more');
    if (label) label.textContent = 'Available connections';
    // Pills act as multi-select backend toggles.
    document.querySelectorAll('.mode').forEach((b) => {
      const enabled = agentBackends.has(b.dataset.mode);
      b.classList.toggle('enabled', enabled);
      b.classList.remove('active');
      b.setAttribute('aria-pressed', String(enabled));
    });
    $('mode-hint').textContent = agentHint();
    applyAgentAffordances();
  } else {
    modes.classList.remove('multi');
    modes.setAttribute('aria-label', 'Direct Work IQ protocol; choose one');
    if (label) label.textContent = 'Protocol';
    document.querySelectorAll('.mode').forEach((b) => b.classList.remove('enabled'));
    setMode(mode); // restore single-select direct behaviour
  }
  // Model picker only in agent view.
  $('modelRow')?.classList.toggle('hidden', next !== 'agent');
  $('systemPromptRow')?.classList.toggle('hidden', next !== 'agent');
  $('advancedSetupPromptHint')?.classList.toggle('hidden', next !== 'agent');
  updateContinuationPreview();
}

// Affordances shared by agent view (depend on which backends are enabled).
function applyAgentAffordances() {
  const mcpOn = agentBackends.has('mcp');
  const a2aOn = agentBackends.has('a2a');
  const restOn = agentBackends.has('rest');
  // Agent routing (agentId) is relevant when MCP or A2A is enabled.
  $('agentId').classList.toggle('hidden', !(mcpOn || a2aOn));
  $('listAgents').classList.toggle('hidden', !mcpOn);
  if (!mcpOn) $('agents-out').classList.add('hidden');
  // REST and MCP ask accept OneDrive/SharePoint file URLs.
  syncComposerContext();
  document.querySelector('.web-toggle')?.classList.toggle('hidden', !restOn);
  if ($('attach-hint')) {
    $('attach-hint').textContent = restOn
      ? 'REST accepts OneDrive/SharePoint file URLs and a per-message web grounding setting. MCP ask can also receive the file URLs.'
      : 'The MCP ask tool can receive OneDrive and SharePoint file URLs as explicit context.';
  }
  // Agent live execution is always on; this preference controls answer deltas.
  const streamBox = $('stream');
  const streamLabel = streamBox.closest('label');
  streamBox.checked = responseStreamingPreference;
  streamBox.disabled = false;
  streamLabel.classList.remove('disabled');
  streamLabel.title = '';
  $('mode-hint').textContent = agentHint();
  updatePromptRouteChip();
  updateActiveConnection();
  updateContinuationPreview();
  syncMcpToolSurface();
}

function setMode(next) {
  setAgentRouteNotice('');
  mode = next;
  document.querySelectorAll('.mode').forEach((b) => {
    const active = b.dataset.mode === next;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('mode-hint').textContent = HINTS[next];
  // Agent routing is available on A2A and MCP (REST always uses the default agent).
  $('agentId').classList.toggle('hidden', next === 'rest');
  // Agent discovery (list_agents) is an MCP-only helper.
  $('listAgents').classList.toggle('hidden', next !== 'mcp');
  if (next === 'rest') $('agents-out').classList.add('hidden');

  // REST and MCP ask accept OneDrive/SharePoint file URLs.
  syncComposerContext();
  document.querySelector('.web-toggle')?.classList.toggle('hidden', next !== 'rest');
  if ($('attach-hint')) {
    $('attach-hint').textContent =
      next === 'rest'
        ? 'REST accepts OneDrive/SharePoint file URLs and a per-message web grounding setting.'
        : 'The MCP ask tool can receive OneDrive and SharePoint file URLs as explicit context.';
  }

  // Work IQ MCP ask returns one tool result; its documented contract has no content stream.
  const streamBox = $('stream');
  const streamLabel = streamBox.closest('label');
  if (next === 'mcp') {
    streamBox.checked = false;
    streamBox.disabled = true;
    streamLabel.classList.add('disabled');
    streamLabel.title = 'Work IQ MCP ask returns one complete tool result';
  } else {
    streamBox.checked = responseStreamingPreference;
    streamBox.disabled = false;
    streamLabel.classList.remove('disabled');
    streamLabel.title = '';
  }

  updateActiveConnection();
  updatePromptRouteChip();
  updateContinuationPreview();
  syncMcpToolSurface();
}

$('stream').addEventListener('change', () => {
  responseStreamingPreference = $('stream').checked;
});

// Pills behave as backend toggles (agent view) or single-select mode (direct view).
document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (view === 'agent') {
      const b = btn.dataset.mode;
      if (agentBackends.has(b)) agentBackends.delete(b);
      else agentBackends.add(b);
      if (agentBackends.size === 0) agentBackends.add(b); // keep at least one
      btn.classList.toggle('enabled', agentBackends.has(b));
      btn.setAttribute('aria-pressed', String(agentBackends.has(b)));
      applyAgentAffordances();
    } else {
      setMode(btn.dataset.mode);
    }
  });
});

document.querySelectorAll('.view').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view, { explicit: true }));
});

// ── Explicit file context ──────────────────────────────────────────────────
// REST sends these as contextualResources.files; MCP ask sends them as fileUrls.
const attachments = { uris: [] };

function renderAttachments() {
  const list = $('attach-list');
  if (!list) return;
  const chips = [];
  attachments.uris.forEach((u, i) => {
    chips.push(
      `<span class="chip chip-uri tool-chip" title="${escapeHtml(u)}">` +
      '<svg class="chip-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.8 12.2 12.2 7.8M6.3 14.7l-1 .9a3.2 3.2 0 0 1-4.5-4.5l3.1-3.2a3.2 3.2 0 0 1 4.5 0M13.7 5.3l1-.9a3.2 3.2 0 0 1 4.5 4.5L16.1 12a3.2 3.2 0 0 1-4.5 0"/></svg>' +
      `${escapeHtml(shortUri(u))}<button class="chip-x" data-kind="uri" data-i="${i}" aria-label="Remove">×</button></span>`
    );
  });
  list.innerHTML = chips.join('');
  const count = $('contextCount');
  if (count) count.textContent = `${attachments.uris.length} file${attachments.uris.length === 1 ? '' : 's'}`;
  const toggle = $('contextToggle');
  if (toggle) toggle.setAttribute('aria-label', `Toggle work context, ${attachments.uris.length} file${attachments.uris.length === 1 ? '' : 's'} selected`);
}

function shortUri(u) {
  try {
    const url = new URL(u);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
    return name.length > 40 ? name.slice(0, 37) + '…' : name;
  } catch {
    return u.length > 40 ? u.slice(0, 37) + '…' : u;
  }
}

function addUri(value) {
  const u = (value || '').trim();
  if (!u) return false;
  if (!/^https:\/\//i.test(u)) {
    alert('Please paste a full https:// OneDrive or SharePoint file URL.');
    return false;
  }
  if (!attachments.uris.includes(u)) attachments.uris.push(u);
  renderAttachments();
  return true;
}

// Commit whatever the user left typed in the URL box (e.g. pasted a link but
// clicked "Ask" without pressing Enter) so the attachment isn't silently dropped.
function flushPendingUri() {
  const uriInput = $('uriInput');
  if (!uriInput) return;
  const v = uriInput.value.trim();
  if (!v) return;
  if (addUri(v)) uriInput.value = '';
}

function clearAttachments() {
  attachments.uris = [];
  renderAttachments();
}

(function wireAttachments() {
  const uriInput = $('uriInput');
  const list = $('attach-list');
  if (uriInput) {
    uriInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (addUri(uriInput.value)) uriInput.value = '';
      }
    });
    // Also commit on blur so a pasted-but-not-Entered URL still counts.
    uriInput.addEventListener('blur', () => flushPendingUri());
  }
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip-x');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      attachments.uris.splice(i, 1);
      renderAttachments();
    });
  }
  $('contextToggle')?.addEventListener('click', () => {
    contextPanelCollapsed = !contextPanelCollapsed;
    syncComposerContext();
    if (!contextPanelCollapsed) $('uriInput')?.focus();
  });
})();

// ── Agent discovery (MCP list_agents) ───────────────────────────────────────
function agentPillsHtml(agents) {
  const selectedId = $('agentId')?.value.trim() || '';
  const choices = [
    { agentId: '', name: 'Default Work IQ agent', provider: null },
    ...agents,
  ];
  return choices
    .map(
      (agent) => {
        const id = agent.agentId || '';
        const selected = id === selectedId;
        return (
        `<button type="button" role="option" class="agent-pill${selected ? ' selected' : ''}" data-id="${escapeHtml(id)}" ` +
        `data-name="${escapeHtml(agent.name || agent.agentId || 'Agent')}" aria-selected="${selected}" title="Chat with this agent">` +
        `${escapeHtml(agent.name || agent.agentId || 'Agent')}` +
        `${agent.provider ? ` <span class="agent-prov">· ${escapeHtml(agent.provider)}</span>` : ''}</button>`
        );
      }
    )
    .join('');
}

function renderAgentDiscovery({ loading = false, error = null } = {}) {
  const advanced = $('agents-out');
  const picker = $('agentPickerList');
  if (loading) {
    if (advanced && !advanced.classList.contains('hidden')) advanced.textContent = 'Loading agents…';
    if (picker) picker.innerHTML = '<span class="agent-picker-status">Discovering available agents…</span>';
    return;
  }

  if (error) {
    const message = escapeHtml(error);
    if (advanced) {
      advanced.innerHTML =
        `<span class="error">${message}</span>` +
        (/does not expose/.test(error)
          ? '<div class="agents-hint">This connection does not expose <code>list_agents</code>. Check the active Work IQ server and tenant configuration.</div>'
          : '');
    }
    if (picker) picker.innerHTML = `<span class="agent-picker-status">${message}</span>`;
    return;
  }

  const agents = discoveredAgents || [];
  const html = agents.length
    ? agentPillsHtml(agents)
    : '<span class="agent-picker-status">No available agents were returned.</span>';
  if (advanced) advanced.innerHTML = html;
  if (picker) picker.innerHTML = html;
}

async function loadAgents({ force = false, showAdvanced = false } = {}) {
  const advanced = $('agents-out');
  if (showAdvanced) advanced?.classList.remove('hidden');
  if (discoveredAgents && !force) {
    renderAgentDiscovery();
    return discoveredAgents;
  }
  if (agentDiscoveryPromise && !force) return agentDiscoveryPromise;

  agentDiscoveryAttempted = true;
  renderAgentDiscovery({ loading: true });
  $('listAgents').disabled = true;
  agentDiscoveryPromise = (async () => {
    try {
      const response = await fetch('/api/mcp/agents');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to discover agents.');
      discoveredAgents = Array.isArray(data.agents) ? data.agents : [];
      renderAgentDiscovery();
      window.dispatchEvent(new CustomEvent('workiq:agents', { detail: { agents: discoveredAgents } }));
      return discoveredAgents;
    } catch (error) {
      renderAgentDiscovery({ error: error.message });
      window.dispatchEvent(new CustomEvent('workiq:agents', { detail: { agents: [], error: error.message } }));
      return [];
    } finally {
      agentDiscoveryPromise = null;
      $('listAgents').disabled = false;
    }
  })();
  return agentDiscoveryPromise;
}

function selectAgent(pill) {
  const requestedId = pill.dataset.id || '';
  const currentId = $('agentId').value.trim();
  const id = requestedId && requestedId !== currentId ? requestedId : '';
  $('agentId').value = id;
  let routeNotice = '';

  if (id) {
    if (view === 'direct') {
      if (mode === 'rest') {
        setMode('a2a');
        routeNotice = `REST cannot address a specific agent. Switched to Direct A2A for ${pill.dataset.name || id}.`;
      }
    } else if (!agentBackends.has('a2a') && !agentBackends.has('mcp')) {
      agentBackends.add('a2a');
      applyAgentAffordances();
    }
  }

  const routeLabel =
    view === 'direct'
      ? `Direct ${mode.toUpperCase()}`
      : `Agent orchestrated via ${orderedAgentBackends().map((backend) => backend.toUpperCase()).join(' + ')}`;
  $('selectedAgent').textContent = id
    ? `${pill.dataset.name || id} · ${routeLabel}`
    : 'Default Work IQ agent';
  setAgentRouteNotice(routeNotice);
  renderAgentDiscovery();
  updateActiveConnection();
}

function setAgentRouteNotice(message) {
  const notice = $('agentRouteNotice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('hidden', !message);
}

$('listAgents')?.addEventListener('click', () => loadAgents({ force: true, showAdvanced: true }));
for (const id of ['agents-out', 'agentPickerList']) {
  $(id)?.addEventListener('click', (event) => {
    const pill = event.target.closest('.agent-pill');
    if (pill) selectAgent(pill);
  });
}
$('chatWithAgent')?.addEventListener('click', async () => {
  const picker = $('agentPickerList');
  const opening = picker.classList.contains('hidden');
  picker.classList.toggle('hidden', !opening);
  $('chatWithAgent').setAttribute('aria-expanded', String(opening));
  if (opening && !agentDiscoveryAttempted) await loadAgents();
});

function updateActiveConnection() {
  const box = $('activeConnection');
  if (!box) return;
  let route;
  let detail;
  const selectedAgent = $('agentId')?.value.trim();
  if (view === 'agent') {
    const connections = orderedAgentBackends().map((b) => b.toUpperCase()).join(' + ');
    route = `Azure OpenAI → ${connections} → Work IQ${selectedAgent ? ` agent ${shortId(selectedAgent)}` : ''}`;
    detail = 'Your model orchestrates dynamically; Work IQ calls stay delegated to the signed-in user.';
  } else {
    const names = { rest: 'REST', a2a: 'A2A', mcp: 'MCP' };
    route = `This app → ${names[mode]} → Work IQ${selectedAgent ? ` agent ${shortId(selectedAgent)}` : ''}`;
    detail =
      mode === 'rest'
        ? 'Conversational HTTPS with optional SSE, file context, and web grounding.'
        : mode === 'a2a'
          ? 'A2A 1.0 JSON-RPC with structured tasks and context IDs.'
          : labConfig?.runtime?.activeMcp?.detail || 'MCP tools over the configured transport.';
  }
  box.innerHTML = `<span>Current route</span><strong>${escapeHtml(route)}</strong><small>${escapeHtml(detail)}</small>`;
}

const CONTINUATION_METHODS = {
  rest: {
    label: 'REST conversationId',
    detail: 'Native REST state: the ID is reused in /conversations/{id}/chat.',
  },
  a2a: {
    label: 'A2A contextId',
    detail: 'Native A2A state: contextId is sent on the next SendMessage request.',
  },
  mcp: {
    label: 'MCP conversationId',
    detail: 'Native Work IQ ask state: conversationId is sent back as the next tool argument.',
  },
  llm: {
    label: 'Agent + native Work IQ state',
    detail: 'Azure OpenAI receives prior messages, while each Work IQ backend reuses its own REST conversationId, A2A contextId, or MCP conversationId.',
  },
};

function continuationIdentifiers(ids) {
  if (!ids || typeof ids !== 'object') return '';
  return ['rest', 'a2a', 'mcp']
    .filter((backend) => ids[backend])
    .map((backend) => `${backend.toUpperCase()}: ${shortId(ids[backend])}`)
    .join(' · ');
}

function renderContinuationState({ mode: requestMode, enabled, continued, turn, id, complete = false }) {
  const method = CONTINUATION_METHODS[requestMode] || CONTINUATION_METHODS.llm;
  const title = $('continuationTitle');
  const detail = $('continuationDetail');
  const identifier = $('continuationId');
  if (!title || !detail || !identifier) return;

  if (!enabled) {
    title.textContent = `Single turn · ${method.label}`;
    detail.textContent = `Continue conversation is off. ${method.detail}`;
    identifier.textContent =
      requestMode === 'llm'
        ? 'Agent history and native Work IQ identifiers will not be retained'
        : complete && id
          ? `Returned but not retained: ${id}`
          : 'No state will be reused';
    return;
  }

  title.textContent = `${continued ? 'Reused' : 'New'} · ${method.label}`;
  detail.textContent = method.detail;
  if (requestMode === 'llm') {
    const nativeIds = continuationIdentifiers(id);
    identifier.textContent =
      `Turn ${turn} · ${Math.max(0, turn - 1)} prior agent turn${turn === 2 ? '' : 's'}` +
      (nativeIds ? ` · ${nativeIds}` : complete ? ' · no native ID returned' : '');
  } else if (id) {
    identifier.textContent = id;
  } else {
    identifier.textContent = complete ? 'No continuation identifier returned' : 'Identifier established by the response';
  }
}

function updateContinuationPreview() {
  const requestMode = view === 'agent' ? 'llm' : mode;
  const enabled = Boolean($('multiturn')?.checked);
  const id = requestMode === 'llm' ? agentConversationIds : conversationIds[requestMode];
  const continued =
    requestMode === 'llm'
      ? agentHistory.length > 0 || Object.values(agentConversationIds).some(Boolean)
      : Boolean(id);
  const turn = continued ? conversationTurns[requestMode] + 1 : 1;
  renderContinuationState({ mode: requestMode, enabled, continued, turn, id });
}

function continuationForRequest(payload, enabled) {
  const requestMode = payload.mode;
  const continued =
    requestMode === 'llm'
      ? (Array.isArray(payload.history) && payload.history.length > 0) ||
        Object.values(payload.backendConversationIds || {}).some(Boolean)
      : Boolean(payload.conversationId);
  return {
    mode: requestMode,
    enabled,
    continued,
    turn: continued ? conversationTurns[requestMode] + 1 : 1,
    id: requestMode === 'llm' ? payload.backendConversationIds || {} : payload.conversationId || null,
  };
}

function setRailState(state, label) {
  const el = $('railState');
  if (!el) return;
  el.className = `rail-state ${state}`;
  el.textContent = label || state;
}

function thinkingCardHtml(requestMode) {
  const title = requestMode === 'llm' ? 'Agent orchestrating' : 'Work IQ processing';
  return `<details class="thinking-card" open>
    <summary>
      <span class="thinking-loader" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="thinking-title">${title}</span>
      <span class="thinking-time">0.0s</span>
      <svg class="thinking-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
    </summary>
    <div class="thinking-detail">Preparing delegated context and the request route…</div>
  </details>`;
}

function thinkingElapsed(ms) {
  return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
}

function startThinking(el) {
  const state = { startedAt: performance.now(), interval: null, finished: false };
  state.interval = window.setInterval(() => {
    const time = el.querySelector('.thinking-time');
    if (time) time.textContent = thinkingElapsed(performance.now() - state.startedAt);
  }, 100);
  thinkingTimers.set(el, state);
}

function updateThinking(el, detail) {
  const target = el?.querySelector('.thinking-detail');
  if (target && detail) target.textContent = detail;
}

function finishThinking(el, detail = 'Grounded response ready') {
  const state = thinkingTimers.get(el);
  if (!state || state.finished) return;
  state.finished = true;
  window.clearInterval(state.interval);
  const elapsed = thinkingElapsed(performance.now() - state.startedAt);
  el.dataset.thinkingElapsed = elapsed;
  const card = el.querySelector('.thinking-card');
  if (!card) return;
  card.classList.add('complete');
  card.open = false;
  const title = card.querySelector('.thinking-title');
  const time = card.querySelector('.thinking-time');
  if (title) {
    title.textContent = el.dataset.requestMode === 'llm'
      ? 'Agent orchestrated for'
      : 'Work IQ processed for';
  }
  if (time) time.textContent = elapsed;
  updateThinking(el, detail);
}

function resetPipeline() {
  document.querySelectorAll('#pipeline li').forEach((item) => {
    item.classList.remove('active', 'complete', 'error');
    const status = item.querySelector('small');
    if (status) status.textContent = 'Waiting';
  });
  $('metricLatency').textContent = '—';
  $('metricSources').textContent = '—';
  $('metricSourcesNote').textContent = 'Structured citations';
  $('metricTools').textContent = '—';
  $('metricConversation').textContent = '1';
  $('executionLog').innerHTML = '<p>Run a prompt to populate the request trace.</p>';
  setRailState('ready', 'Ready');
  activeContinuation = null;
  updateContinuationPreview();
}

function setPipelineStage(stage, state, detail) {
  const item = $(`pipe-${stage}`);
  if (!item) return;
  item.classList.remove('active', 'complete', 'error');
  if (state === 'running') item.classList.add('active');
  else if (state === 'complete') item.classList.add('complete');
  else if (state === 'error') item.classList.add('error');
  const status = item.querySelector('small');
  if (status) {
    status.textContent =
      detail ||
      (state === 'running' ? 'In progress' : state === 'complete' ? 'Complete' : state === 'error' ? 'Blocked' : 'Waiting');
  }
}

function beginPipeline(payload, multiturn) {
  resetPipeline();
  setRailState('running', 'Running');
  setPipelineStage('identity', 'running', 'Preparing delegated user context');
  activeContinuation = continuationForRequest(payload, multiturn);
  $('metricConversation').textContent = String(activeContinuation.turn);
  renderContinuationState(activeContinuation);
  $('executionLog').innerHTML =
    `<div class="log-step"><strong>Client request prepared</strong><span>${escapeHtml(payload.mode.toUpperCase())}</span>` +
    `<small>${escapeHtml(payload.question)}</small></div>`;
}

function lifecycleEvent(data) {
  if (!data?.stage) return;
  setPipelineStage(data.stage, data.state, data.detail);
  if (data.state === 'running') updateThinking(activeAssistantBubble, data.detail);
}

function executionLogHtml(trace) {
  if (!Array.isArray(trace) || !trace.length) return '<p>No trace steps were returned.</p>';
  return trace
    .map((step) => {
      const endpoint = step.request?.url || step.request?.tool || step.detail?.transport || '';
      return `<div class="log-step${step.ok === false ? ' error' : ''}">` +
        `<strong>${escapeHtml(step.title || step.kind || 'Step')}</strong>` +
        `<span>${escapeHtml(step.durationMs ? `${step.durationMs} ms` : step.kind || '')}</span>` +
        `${endpoint ? `<small>${escapeHtml(endpoint)}</small>` : ''}</div>`;
    })
    .join('');
}

function completePipeline(data) {
  for (const stage of ['identity', 'route', 'workiq', 'answer']) {
    setPipelineStage(stage, 'complete');
  }
  const deniedStep = policyDeniedStep(data.steps);
  if (deniedStep) {
    setPipelineStage('workiq', 'error', 'MCP mutation blocked by tenant policy');
    setRailState('error', 'Policy blocked');
  } else {
    setRailState('complete', 'Complete');
  }
  $('metricLatency').textContent = data.latencyMs != null ? `${data.latencyMs} ms` : '—';
  if (data.sourcesStatus === 'unavailable') {
    $('metricSources').textContent = 'N/A';
    $('metricSourcesNote').textContent = data.sourceNote || 'This route returns no structured citations';
  } else if (data.sourcesStatus === 'not-applicable') {
    $('metricSources').textContent = '—';
    $('metricSourcesNote').textContent = data.sourceNote || 'No Work IQ tool call';
  } else {
    $('metricSources').textContent = String(data.sources?.length || 0);
    $('metricSourcesNote').textContent = data.sourceNote || 'Structured citations returned';
  }
  $('metricTools').textContent = String(data.steps?.length || (data.toolUsed ? 1 : 0));
  if (activeContinuation) {
    const responseId =
      activeContinuation.mode === 'llm'
        ? data.backendConversationIds || {}
        : data.conversationId || null;
    if (activeContinuation.enabled) conversationTurns[activeContinuation.mode] = activeContinuation.turn;
    $('metricConversation').textContent = String(activeContinuation.turn);
    renderContinuationState({ ...activeContinuation, id: responseId, complete: true });
  }
  $('executionLog').innerHTML = executionLogHtml(data.trace);
}

function failPipeline(message) {
  const active = document.querySelector('#pipeline li.active');
  if (active) setPipelineStage(active.dataset.stage, 'error', message || 'Request failed');
  else setPipelineStage('answer', 'error', message || 'Request failed');
  if (activeContinuation) renderContinuationState({ ...activeContinuation, complete: true });
  setRailState('error', 'Blocked');
}

async function loadLabConfig() {
  try {
    const r = await fetch('/api/lab/config');
    if (!r.ok) return;
    labConfig = await r.json();
    const rest = labConfig.protocols?.rest;
    if (rest) {
      const channel = rest.channel === 'beta' ? 'preview ' : '';
      HINTS.rest =
        `REST · ${channel}${rest.endpoint}/conversations · ${rest.transport} · delegated WorkIQAgent.Ask token.`;
    }
    const mcp = labConfig.runtime?.activeMcp;
    if (mcp?.detail) HINTS.mcp = `MCP · ${mcp.detail}.`;
    updateActiveConnection();
  } catch {
    // The static briefing remains usable if metadata is unavailable.
  }
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) throw new Error(`Status request failed (${r.status})`);
    const s = await r.json();
    const el = $('status');
    const signin = $('signin');
    const runtimeHead = $('runtimeHead');
    // Reflect the active MCP transport (remote HTTP vs local CLI) in the hint.
    if (s.mcpTransport?.detail) {
      HINTS.mcp = `MCP · ${s.mcpTransport.detail}.`;
      if (mode === 'mcp') $('mode-hint').textContent = HINTS.mcp;
    }
    if (s.restTransport?.endpoint) {
      const channel = s.restTransport.channel === 'beta' ? 'preview ' : '';
      HINTS.rest =
        `REST · ${channel}${s.restTransport.endpoint}/conversations · JSON or SSE · delegated WorkIQAgent.Ask token.`;
      if (mode === 'rest' && view === 'direct') $('mode-hint').textContent = HINTS.rest;
    }
    if (!s.configured) {
      el.textContent = 'Runtime not configured';
      el.className = 'status warn';
      runtimeHead?.classList.remove('hidden');
      $('runtimePulse')?.classList.add('warn');
      $('runtimePulse')?.classList.remove('ok');
      signin.classList.add('hidden');
      setUser(null);
    } else if (s.signedInUser) {
      el.textContent = '';
      el.className = 'status';
      runtimeHead?.classList.add('hidden');
      $('runtimePulse')?.classList.add('ok');
      $('runtimePulse')?.classList.remove('warn');
      signin.classList.add('hidden');
      setUser(s.signedInUser);
      if (!agentDiscoveryAttempted) loadAgents();
    } else {
      el.textContent = '';
      el.className = 'status';
      runtimeHead?.classList.add('hidden');
      $('runtimePulse')?.classList.remove('ok', 'warn');
      signin.classList.remove('hidden');
      setUser(null);
    }
    updateActiveConnection();
  } catch {
    $('status').textContent = 'Status unavailable';
    $('runtimeHead')?.classList.remove('hidden');
    $('runtimePulse')?.classList.add('warn');
  }
}

// Reflect the signed-in identity in the header account control.
function setUser(user) {
  const nameEl = $('userName');
  const avatarEl = $('userAvatar');
  if (!nameEl || !avatarEl) return;
  $('userRow')?.classList.toggle('hidden', !user);
  $('signout')?.classList.toggle('hidden', !user);
  if (!user) {
    nameEl.textContent = 'Not signed in';
    avatarEl.textContent = '·';
    return;
  }
  const identity =
    typeof user === 'string' ? user : user.name || user.displayName || user.username || user.email || 'Signed-in user';
  const display = String(identity).split('@')[0];
  nameEl.textContent = display;
  const initials = display
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
  avatarEl.textContent = initials || display[0]?.toUpperCase() || '·';
}

// Work IQ answers come back as Markdown: inline [label](url) links, **bold**,
// ## headings, bullet lists, and 【id】 citation markers. Render that to safe
// HTML so links are clickable (showing the label, not the raw URL).
function renderMarkdown(text, sources) {
  const normalized = window.WorkIqAnswerFormatter?.normalize(text) ?? String(text == null ? '' : text);
  const lines = normalized.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // Table: a row of pipes followed by a separator row (| --- | --- |).
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]) && lines[j].trim() !== '') {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      out.push(tableHtml(header, rows, sources));
      i = j - 1;
      continue;
    }

    if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*{3,}\s*$/.test(line)) {
      out.push('<hr class="md-hr">');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<div class="md-h md-h${h[1].length}">${inlineMarkdown(h[2], sources)}</div>`);
      continue;
    }
    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) {
      const depth = Math.min(Math.floor(li[1].length / 2), 6);
      out.push(
        `<div class="md-li md-depth-${depth}">${inlineMarkdown(li[2], sources)}</div>`
      );
      continue;
    }
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      const depth = Math.min(Math.floor(ol[1].length / 2), 6);
      out.push(
        `<div class="md-li md-ol md-depth-${depth}"><span class="md-ol-num">${ol[2]}.</span> ${inlineMarkdown(ol[3], sources)}</div>`
      );
      continue;
    }
    if (line.trim() === '') {
      out.push('<div class="md-sp"></div>');
      continue;
    }
    out.push(`<div class="md-p">${inlineMarkdown(line, sources)}</div>`);
  }
  return out.join('');
}

// A line is a table row if it contains at least one unescaped pipe and a pipe
// that isn't just leading/trailing text (we also accept rows without outer pipes).
function isTableRow(line) {
  const s = String(line).trim();
  return s.includes('|') && /\|/.test(s);
}

// Separator row: cells made only of dashes/colons, e.g. | --- | :--: |
function isTableSeparator(line) {
  const s = String(line).trim();
  if (!s.includes('-')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(s);
}

function splitTableRow(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on pipes that aren't escaped (\|).
  return s
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

function tableHtml(header, rows, sources) {
  const ths = header.map((c) => `<th>${inlineMarkdown(c, sources)}</th>`).join('');
  const trs = rows
    .map((cells) => {
      // Pad/truncate to the header width so columns line up.
      const tds = [];
      for (let k = 0; k < header.length; k++) {
        tds.push(`<td>${inlineMarkdown(cells[k] ?? '', sources)}</td>`);
      }
      return `<tr>${tds.join('')}</tr>`;
    })
    .join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

// Inline-level Markdown: escape first, then links / bold / italic / code /
// citation markers. Only http(s) links are allowed.
function inlineMarkdown(s, sources = []) {
  // Strip Work IQ entity tags (e.g. <Person>John Doe</Person>) that can appear
  // in streamed text — keep the inner display text, drop the tags.
  let h = escapeHtml(stripEntityTags(s));

  // Inline code
  h = h.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);

  // Markdown links [label](https://…) → clickable label, raw URL hidden.
  // The URL pattern allows one level of balanced parentheses so SharePoint/
  // Teams URLs like …/Specs%20(final)/… or …meeting_abc(123)@… aren't cut off
  // at the first ")". The final ")" is the Markdown link delimiter.
  h = h.replace(
    /\[([^\]]*)\]\(((?:[^\s()]|\([^()]*\))+)\)/g,
    (m, label, url) => {
      const text = label.trim() || 'link';
      const safeUrl = safeExternalUrl(url);
      if (!safeUrl) return text;
      return `<a class="md-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" title="${escapeHtml(
        decodeURLForTitle(safeUrl)
      )}">${text}</a>`;
    }
  );

  // Bare URLs (not already inside an href) → clickable, showing a short label.
  h = linkifyBareUrls(h);

  // Bold then italic.
  h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

  // Work IQ uses either 1-based numeric markers or opaque reference IDs.
  h = h.replace(/【\s*([^】]+?)\s*】/g, (m, id) => {
    return citationLink(id.trim(), sources, id.trim());
  });

  // Plain numeric [1] / [1, 2] citation markers → linked chips when we have sources.
  h = h.replace(/\[\^?(\d+(?:\s*,\s*\d+)*)\^?\]/g, (match, nums) =>
    nums
      .split(',')
      .map((n) => citationLink(parseInt(n.trim(), 10), sources))
      .join('')
  );

  return h;
}

function decodeURLForTitle(url) {
  try {
    return decodeURIComponent(url.replace(/&amp;/g, '&'));
  } catch {
    return url.replace(/&amp;/g, '&');
  }
}

// Linkify bare http(s) URLs that aren't already inside an <a> tag. Shows a
// shortened label (filename or host) rather than the full long URL.
function linkifyBareUrls(h) {
  const parts = String(h).split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g);
  return parts
    .map((part) => {
      if (part.startsWith('<a')) return part;
      return part.replace(
        /(^|[\s(>])((?:https?:\/\/)(?:[^\s()<>]|\([^\s()<>]*\))+)/g,
        (m, pre, url) => {
          let u = url;
          let trail = '';
          while (/[.,;:!?]$/.test(u)) {
            trail = u.slice(-1) + trail;
            u = u.slice(0, -1);
          }
          const safe = safeExternalUrl(u);
          if (!safe) return `${pre}${u}${trail}`;
          return `${pre}<a class="md-link" href="${escapeHtml(safe)}" target="_blank" rel="noopener" title="${escapeHtml(
            decodeURLForTitle(safe)
          )}">${escapeHtml(shortUri(u))}</a>${trail}`;
        }
      );
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Remove Work IQ semantic entity tags that wrap display text in some responses,
// e.g. <Person>John Doe</Person> → John Doe. Only known tag names are stripped.
function stripEntityTags(s) {
  return String(s).replace(
    /<\/?(?:Person|Event|File|Email|Meeting|Document|Time|Date|Location|Phone|Address|Team|Channel|Chat)\b[^>]*>/gi,
    ''
  );
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value).replace(/&amp;/g, '&'));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function citationLink(reference, sources, fallbackTitle) {
  const referenceText = String(reference);
  const idIndex = (sources || []).findIndex((source) => String(source?.id || '') === referenceText);
  const numericIndex = /^\d+$/.test(referenceText) ? Number(referenceText) - 1 : -1;
  const sourceIndex = idIndex >= 0 ? idIndex : numericIndex;
  const src = sourceIndex >= 0 ? sources?.[sourceIndex] : null;
  const number = src ? sourceIndex + 1 : numericIndex >= 0 ? numericIndex + 1 : null;
  const title = src
    ? src.title || src.provider || `Source ${number}`
    : fallbackTitle || (number ? `Source ${number}` : 'Source');
  const safeUrl = src?.url ? safeExternalUrl(src.url) : null;
  if (safeUrl) {
    return `<a class="cite cite-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${number}</a>`;
  }
  return `<sup class="cite cite-plain" title="${escapeHtml(title)}">${number || '•'}</sup>`;
}

function sourceIconHtml(resourceType) {
  const type = String(resourceType || '').toLowerCase();
  if (type.includes('email') || type.includes('mail')) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3.5 6 6.5 5 6.5-5"/></svg>';
  }
  if (type.includes('meeting') || type.includes('event')) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M6 2.8v3.4M14 2.8v3.4M3 8h14M6.5 11h2M11.5 11h2"/></svg>';
  }
  if (type.includes('file') || type.includes('document')) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4M7.5 10h5M7.5 13h5"/></svg>';
  }
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.8 12.2 12.2 7.8M6.3 14.7l-1 .9a3.2 3.2 0 0 1-4.5-4.5l3.1-3.2a3.2 3.2 0 0 1 4.5 0M13.7 5.3l1-.9a3.2 3.2 0 0 1 4.5 4.5L16.1 12a3.2 3.2 0 0 1-4.5 0"/></svg>';
}

function referencesHtml(sources, label = 'References') {
  if (!sources || !sources.length) return '';
  const items = sources
    .map((s, i) => {
      const n = i + 1;
      const title = escapeHtml(s.title || `Source ${n}`);
      const safeUrl = s.url ? safeExternalUrl(s.url) : null;
      const badge = safeUrl
        ? `<a class="ref-num" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" title="${escapeHtml(safeUrl)}">${n}</a>`
        : `<span class="ref-num ref-num-plain">${n}</span>`;
      const resourceType = s.resourceType && s.resourceType !== 'source' ? s.resourceType : '';
      const provider = s.provider && s.provider !== s.title ? s.provider : '';
      return (
        '<li class="context-card">' +
        `<span class="context-card-icon">${sourceIconHtml(resourceType)}</span>` +
        '<span class="context-card-copy">' +
        `<span class="ref-title">${title}</span>` +
        '<span class="context-card-meta">' +
        `${resourceType ? `<span class="ref-type">${escapeHtml(resourceType)}</span>` : ''}` +
        `${provider ? `<span class="ref-provider">${escapeHtml(provider)}</span>` : ''}` +
        '</span></span>' +
        `${badge}</li>`
      );
    })
    .join('');
  return `<div class="refs"><span class="refs-label">${escapeHtml(label)}</span><ol class="ref-list">${items}</ol></div>`;
}

const KIND_TAG = {
  auth: 'auth',
  http: 'http',
  parse: 'parse',
  process: 'process',
  tool: 'tool',
  info: 'info',
};

function jsonBlock(label, value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `<h4>${escapeHtml(label)}</h4><pre>${escapeHtml(text)}</pre>`;
}

function traceHtml(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return '';

  const total = trace.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const summary = `(${trace.length} steps · ${total} ms)`;

  const steps = trace
    .map((s) => {
      const kind = s.kind || 'info';
      const failed = s.ok === false;
      const tag = KIND_TAG[kind] || kind;

      let status = '';
      if (s.response && s.response.status != null) {
        const cls = s.response.status < 400 ? 'good' : 'bad';
        status = `<span class="trace-status ${cls}">HTTP ${escapeHtml(s.response.status)} ${escapeHtml(s.response.statusText || '')}</span>`;
      } else if (s.error) {
        status = `<span class="trace-status bad">error</span>`;
      }

      // Build the expandable body (request / response / detail / error).
      let body = '';
      if (s.request) {
        const reqMeta = s.request.method
          ? `${s.request.method} ${s.request.url || ''}\n${stringifyHeaders(s.request.headers)}`
          : null;
        if (reqMeta) body += jsonBlock('Request', reqMeta.trim());
        if (s.request.body != null) body += jsonBlock('Request body', s.request.body);
        if (s.request.tool) body += jsonBlock('Tool call', s.request);
      }
      if (s.response) {
        if (s.response.headers) body += jsonBlock('Response headers', s.response.headers);
        if (s.response.body !== undefined) body += jsonBlock('Response body', s.response.body);
        if (s.response.content) body += jsonBlock('Response', s.response);
      }
      if (s.detail) body += jsonBlock('Detail', s.detail);
      if (s.error) body += jsonBlock('Error', s.error);

      const dur = s.durationMs ? `${s.durationMs} ms` : '';
      const head = `
        <summary class="trace-head">
          <span class="trace-title">${escapeHtml(s.title || '(step)')}</span>
          <span class="trace-tag">${escapeHtml(tag)}</span>
          ${status}
          <span class="trace-dur">${escapeHtml(dur)}</span>
        </summary>`;

      const inner = body
        ? `<details>${head}<div class="trace-body">${body}</div></details>`
        : `<div class="trace-head trace-head-static">${headStatic(s, tag, status, dur)}</div>`;

      return `<li class="trace-step kind-${escapeHtml(kind)}${failed ? ' failed' : ''}">
        <span class="trace-dot"></span>${inner}</li>`;
    })
    .join('');

  return `<details class="bts">
      <summary><span class="summary-label">Behind the scenes</span> <span class="count">${summary}</span></summary>
      <ol class="trace">${steps}</ol>
    </details>`;
}

function headStatic(s, tag, status, dur) {
  return `
    <span class="trace-title">${escapeHtml(s.title || '(step)')}</span>
    <span class="trace-tag">${escapeHtml(tag)}</span>
    ${status}
    <span class="trace-dur">${escapeHtml(dur)}</span>`;
}

function stringifyHeaders(headers) {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

const MODE_LABEL = { rest: 'REST', a2a: 'A2A', mcp: 'MCP', llm: 'Agent' };

// ── Agent step timeline ─────────────────────────────────────────────────────
const TOOL_ICON = {
  mcp: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 3.5h-2v4M13.5 16.5h2v-4M4.5 7.5h4v-4M15.5 12.5h-4v4M8 10h4"/></svg>',
  rest: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3a11 11 0 0 1 0 14M10 3a11 11 0 0 0 0 14"/></svg>',
  a2a: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5h9M9 3.5l3 3-3 3M17 13.5H8M11 10.5l-3 3 3 3"/></svg>',
  unknown: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg>',
};

// A short, human-friendly one-liner for the step header (full args go in the
// Request block below it).
function argsSummary(args) {
  try {
    const a = args || {};
    if (Array.isArray(a.entityUrls)) return a.entityUrls.join('   ·   ');
    if (a.path) return a.path + (a.operationType ? `  (${a.operationType})` : '');
    if (a.filter) return `filter: ${a.filter}`;
    if (typeof a.question === 'string') return a.question;
    const s = JSON.stringify(a);
    return s === '{}' ? '' : s;
  } catch {
    return '';
  }
}

// Pretty-print a value for display: parse + re-indent JSON when possible,
// otherwise return the raw text. Never truncates.
function prettyForDisplay(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  const s = String(value).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      /* not valid JSON — show as-is */
    }
  }
  return s;
}

function stepSectionHtml(label, content, extraClass) {
  if (content == null || content === '') return '';
  return `<div class="astep-section ${extraClass || ''}">
      <div class="astep-label">${escapeHtml(label)}</div>
      <pre class="astep-code">${escapeHtml(content)}</pre>
    </div>`;
}

// One step row (live or final). state: 'running' | ok bool.
function agentStepRowHtml(step, state) {
  const icon = TOOL_ICON[step.backend] || TOOL_ICON.unknown;
  let status;
  if (state === 'running') {
    status = `<span class="astep-spin">${step.streaming ? 'opening stream…' : 'running…'}</span>`;
  }
  else status = step.ok ? '<span class="astep-ok">✓ ok</span>' : '<span class="astep-bad">✕ error</span>';

  const backend = step.backend ? `<span class="astep-backend">${escapeHtml(String(step.backend).toUpperCase())}</span>` : '';
  const delivery = step.backend
    ? `<span class="astep-delivery">${step.streaming ? 'SSE stream' : 'single result'}</span>`
    : '';
  const req = stepSectionHtml('Request', prettyForDisplay(step.args ?? {}), 'astep-request');
  const res =
    step.result != null
      ? stepSectionHtml('Response', prettyForDisplay(step.result), step.ok ? 'astep-response' : 'astep-response astep-error')
      : '';

  return `<div class="astep task-row${step.ok === false ? ' is-error' : ''}" data-i="${step.index}">
      <div class="astep-head">
        <span class="tool-chip astep-tool-chip">
          <span class="astep-ico tool-chip-icon">${icon}</span>
          <code class="astep-tool">${escapeHtml(step.tool || '')}</code>
          ${backend}
        </span>
        ${delivery}
        <span class="astep-args">${escapeHtml(argsSummary(step.args))}</span>
        ${status}
      </div>
      <div class="astep-body">${req}${res}</div>
    </div>`;
}

function agentStepsHtml(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const rows = steps.map((s) => agentStepRowHtml(s, s.ok)).join('');
  const policyGuidance = policyDenialGuidanceHtml(steps);
  return `<details class="agent-steps" open>
      <summary><span class="summary-label">Agent steps</span> <span class="count">(${steps.length} tool call${steps.length === 1 ? '' : 's'})</span></summary>
      <div class="asteps-body">${rows}</div>
    </details>${policyGuidance}`;
}

function policyDeniedStep(steps) {
  if (!Array.isArray(steps)) return null;
  return (
    steps.find((step) => {
      if (step?.ok !== false) return false;
      const result = prettyForDisplay(step.result).toLowerCase();
      return result.includes('policy allowlist') || result.includes('policy allow list');
    }) || null
  );
}

function mutationPolicyControl(step) {
  const tool = String(step?.tool || '').toLowerCase();
  if (tool.includes('delete_entity')) return 'Allow delete';
  if (tool.includes('update_entity')) return 'Allow partial update';
  if (tool.includes('create_entity') || tool.includes('do_action')) return 'Allow create';
  return 'the matching mutation control';
}

function policyDenialGuidanceHtml(steps) {
  const step = policyDeniedStep(steps);
  if (!step) return '';
  const args = step.args || {};
  const path = args.actionUrl || args.parentUrl || args.entityUrl || args.path || 'the requested resource path';
  const tool = String(step.tool || '').toLowerCase();
  const method = tool.includes('delete_entity') ? 'DELETE' : tool.includes('update_entity') ? 'PATCH' : 'POST';
  const detail = [
    `BLOCKED BY TENANT POLICY: ${method} ${path}`,
    '',
    'The MCP call reached Work IQ. This is not an OAuth-scope, Azure OpenAI, or MCP transport failure.',
    '',
    'Tenant admin fix:',
    'Microsoft 365 admin center > Agents > Tools > Work IQ MCP > Policies > Mutations',
    `Enable "Allow write actions" and "${mutationPolicyControl(step)}".`,
    '',
    'The setting is tenant-wide and can take up to 24 hours to apply. Do not retry until policy changes.',
  ].join('\n');
  return stepSectionHtml('Governance decision', detail, 'astep-response astep-error');
}

// Ensure the live steps container exists inside the assistant bubble.
function ensureStepsContainer(el) {
  let box = el.querySelector('.agent-steps-live');
  if (!box) {
    box = document.createElement('div');
    box.className = 'agent-steps-live';
    box.innerHTML =
      '<div class="asteps-title">Live execution</div><div class="asteps-body"></div>';
    const body = el.querySelector('.msg-body');
    el.querySelector('.bubble').insertBefore(box, body);
  }
  return box.querySelector('.asteps-body');
}

function liveTraceStep(el, data) {
  const body = ensureStepsContainer(el);
  let row = body.querySelector(`.trace-step[data-trace-i="${data.id}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'astep trace-step';
    row.dataset.traceI = data.id;
    row.innerHTML = `<div class="astep-head">
        <span class="astep-ico">${TOOL_ICON.unknown}</span>
        <span class="astep-tool">${escapeHtml(data.title || 'Operation')}</span>
        <span class="astep-backend">${escapeHtml(String(data.kind || 'step').toUpperCase())}</span>
        <span class="astep-trace-status astep-spin">running…</span>
      </div>`;
    body.appendChild(row);
  }
  if (data.state === 'running') {
    scrollChat();
    return;
  }
  const status = row.querySelector('.astep-trace-status');
  const duration = Number.isFinite(data.durationMs) ? ` · ${data.durationMs} ms` : '';
  const httpStatus = Number.isInteger(data.status) ? ` · HTTP ${data.status}` : '';
  if (status) {
    status.className = `astep-trace-status ${data.state === 'error' ? 'astep-bad' : 'astep-ok'}`;
    status.textContent = `${data.state === 'error' ? '✕ error' : '✓ done'}${httpStatus}${duration}`;
  }
  if (data.state === 'error') row.classList.add('is-error');
  scrollChat();
}

function liveAgentStep(el, step) {
  const body = ensureStepsContainer(el);
  body.insertAdjacentHTML('beforeend', agentStepRowHtml(step, 'running'));
  scrollChat();
}

function liveToolResult(el, data) {
  const row = el.querySelector(`.agent-steps-live .astep[data-i="${data.index}"]`);
  if (!row) return;
  const spin = row.querySelector('.astep-spin');
  if (spin) spin.outerHTML = data.ok ? '<span class="astep-ok">✓ ok</span>' : '<span class="astep-bad">✕ error</span>';
  if (data.ok === false) row.classList.add('is-error');
  const body = row.querySelector('.astep-body');
  if (body && data.result != null && !body.querySelector('.astep-response')) {
    body.insertAdjacentHTML(
      'beforeend',
      stepSectionHtml('Response', prettyForDisplay(data.result), data.ok ? 'astep-response' : 'astep-response astep-error')
    );
  }
  scrollChat();
}

function liveToolStream(el, data) {
  const row = el.querySelector(`.agent-steps-live .astep[data-i="${data.index}"]`);
  if (!row || !data.text) return;
  const spin = row.querySelector('.astep-spin');
  if (spin) spin.textContent = `${String(data.backend || '').toUpperCase()} streaming…`;
  const body = row.querySelector('.astep-body');
  if (!body) return;

  const kind = data.event === 'status' ? 'status' : 'response';
  let section = body.querySelector(`.astep-stream-${kind}`);
  if (!section) {
    section = document.createElement('div');
    section.className = `astep-section astep-stream-${kind}`;
    section.innerHTML =
      `<div class="astep-label">${kind === 'status' ? 'Live Work IQ status' : 'Live Work IQ response'}</div>` +
      '<pre class="astep-code"></pre>';
    body.appendChild(section);
  }
  const output = section.querySelector('.astep-code');
  if (kind === 'status' || data.replace) output.textContent = data.text;
  else output.textContent += data.text;
  scrollChat();
}

// ── Agent model picker ──────────────────────────────────────────────────────
async function loadLlmConfig() {
  try {
    const r = await fetch('/api/llm/config');
    if (!r.ok) return false;
    llmConfig = await r.json();
    const configured = llmConfig.configured !== false;
    currentModel = llmConfig.defaultModel || currentModel;
    defaultSystemPrompt = llmConfig.systemPrompt || '';
    currentSystemPrompt = defaultSystemPrompt;
    const sel = $('llmModel');
    if (sel) {
      const models = llmConfig.models?.length ? llmConfig.models : [currentModel];
      sel.innerHTML = models
        .map((m) => `<option value="${escapeHtml(m)}"${m === currentModel ? ' selected' : ''}>${escapeHtml(m)}</option>`)
        .join('');
      sel.disabled = !configured;
      sel.addEventListener('change', () => {
        currentModel = sel.value;
        if (view === 'agent') $('mode-hint').textContent = agentHint();
      });
    }
    const meta = $('modelMeta');
    if (meta) {
      meta.textContent = configured
        ? `${llmConfig.endpoint} · ${llmConfig.auth}`
        : 'Not configured · see docs/tenant-setup.md';
    }
    const prompt = $('orchestratorPrompt');
    if (prompt) {
      prompt.value = currentSystemPrompt;
      prompt.disabled = !configured;
      prompt.addEventListener('input', () => {
        currentSystemPrompt = prompt.value;
      });
    }
    const resetPrompt = $('resetSystemPrompt');
    if (resetPrompt) {
      resetPrompt.disabled = !configured;
      resetPrompt.addEventListener('click', () => {
        currentSystemPrompt = defaultSystemPrompt;
        prompt.value = defaultSystemPrompt;
      });
    }
    const agentView = document.querySelector('.view[data-view="agent"]');
    if (agentView) {
      agentView.disabled = !configured;
      agentView.title = configured ? '' : 'Configure Azure OpenAI to enable agent orchestration';
    }
    document.querySelectorAll('.example[data-route-view="agent"]').forEach((story) => {
      story.disabled = !configured;
      story.title = configured ? '' : 'Configure Azure OpenAI to run this guided story';
    });
    return configured;
  } catch {
    return false;
  }
}


function chatEl() {
  return $('chat');
}

function showChat() {
  chatEl().classList.remove('hidden');
  $('empty-hint').classList.add('hidden');
}

function clearChat() {
  chatEl().innerHTML = '';
  chatEl().classList.add('hidden');
  $('empty-hint').classList.remove('hidden');
  conversationIds.rest = conversationIds.a2a = conversationIds.mcp = null;
  agentConversationIds.rest = agentConversationIds.a2a = agentConversationIds.mcp = null;
  agentHistory.length = 0;
  for (const key of Object.keys(conversationTurns)) conversationTurns[key] = 0;
  activeContinuation = null;
  resetPipeline();
  window.dispatchEvent(new CustomEvent('workiq:new-chat'));
}

function scrollChat() {
  const c = chatEl();
  c.scrollTop = c.scrollHeight;
}

function appendUserBubble(text) {
  showChat();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  chatEl().appendChild(el);
  scrollChat();
}

function appendAssistantBubble(requestMode) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.requestMode = requestMode;
  el.innerHTML =
    `<div class="bubble">${thinkingCardHtml(requestMode)}<div class="msg-body"></div></div>`;
  chatEl().appendChild(el);
  activeAssistantBubble = el;
  startThinking(el);
  scrollChat();
  return el;
}

// Live streaming helpers — render Markdown as deltas arrive so links/headings
// look right while streaming; references are finalized in fillAssistant.
function streamAppendDelta(el, state, evt) {
  finishThinking(el);
  if (evt.replace) state.text = evt.text || '';
  else state.text += evt.text || '';
  const body = el.querySelector('.msg-body');
  body.innerHTML = renderMarkdown(state.text, []) + '<span class="caret">▋</span>';
  scrollChat();
}

function streamStatus(el, evt) {
  updateThinking(el, evt.text);
  scrollChat();
}

function fillAssistant(el, data) {
  finishThinking(el);
  const thinking = el.querySelector('.thinking-card')?.outerHTML || '';
  const sources = data.sources || [];
  const answer = renderMarkdown(data.answer || '(no answer)', data.mode === 'llm' ? [] : sources);
  el.classList.toggle('error-msg', Boolean(policyDeniedStep(data.steps)));

  const metaParts = [MODE_LABEL[data.mode] || data.mode];
  if (data.mode === 'llm') {
    if (data.model) metaParts.push(data.model);
    if (data.backendsUsed?.length) metaParts.push(`via ${data.backendsUsed.map((b) => b.toUpperCase()).join('+')}`);
    if (data.steps?.length != null) metaParts.push(`${data.steps.length} tool call${data.steps.length === 1 ? '' : 's'}`);
  }
  if (data.transportUsed === 'local-fallback') metaParts.push('via local CLI (remote not enabled for tenant)');
  else if (data.transportUsed) metaParts.push(data.transportUsed);
  if (data.streamed) metaParts.push('streamed');
  if (data.latencyMs != null) metaParts.push(`${data.latencyMs} ms`);
  if (data.toolUsed) metaParts.push(`tool: ${data.toolUsed}`);
  if (data.conversationId) metaParts.push(`ctx: ${shortId(data.conversationId)}`);

  // Remove any live (streaming) step container; the final timeline replaces it.
  el.querySelector('.agent-steps-live')?.remove();

  el.querySelector('.bubble').innerHTML = `
    ${thinking}
    ${data.mode === 'llm' ? agentStepsHtml(data.steps) : ''}
    <div class="msg-body">${answer}</div>
    ${referencesHtml(sources, data.mode === 'llm' ? 'Evidence from Work IQ tool calls' : 'References')}
    <div class="msg-extras">
      ${traceHtml(data.trace)}
      <details class="raw-d"><summary><span class="summary-label">Raw JSON</span></summary><pre class="raw">${escapeHtml(
        JSON.stringify(data.raw ?? data, null, 2)
      )}</pre></details>
    </div>
    <div class="msg-meta">${escapeHtml(metaParts.join(' · '))}</div>`;
  completePipeline(data);
  if (activeAssistantBubble === el) activeAssistantBubble = null;
  window.dispatchEvent(
    new CustomEvent('workiq:result', {
      detail: {
        mode: data.mode,
        conversationId: data.conversationId || null,
        backendConversationIds: data.backendConversationIds || null,
        taskId: data.taskId || null,
        taskHandle: data.taskHandle || null,
        taskState: data.taskState || null,
      },
    })
  );
  scrollChat();
}

function fillAssistantError(el, msg, data) {
  finishThinking(el, 'The request stopped before a grounded answer was ready');
  const thinking = el.querySelector('.thinking-card')?.outerHTML || '';
  el.classList.add('error-msg');
  el.querySelector('.bubble').innerHTML = `
    ${thinking}
    <div class="msg-body"><span class="error">${escapeHtml(msg)}</span></div>
    ${data && data.trace ? `<div class="msg-extras">${traceHtml(data.trace)}</div>` : ''}`;
  if (data?.trace) $('executionLog').innerHTML = executionLogHtml(data.trace);
  failPipeline(msg);
  if (activeAssistantBubble === el) activeAssistantBubble = null;
  scrollChat();
}

function fillAssistantStopped(el) {
  finishThinking(el, 'Stopped by the user');
  const thinking = el.querySelector('.thinking-card')?.outerHTML || '';
  el.querySelector('.bubble').innerHTML =
    `${thinking}<div class="msg-body"><span class="typing">Response stopped.</span></div>`;
  const active = document.querySelector('#pipeline li.active');
  if (active) setPipelineStage(active.dataset.stage, 'error', 'Stopped by user');
  setRailState('ready', 'Stopped');
  $('composerStatus').textContent = 'Response stopped.';
  if (activeAssistantBubble === el) activeAssistantBubble = null;
  scrollChat();
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

function updateComposerState(message) {
  const hasQuestion = Boolean($('question').value.trim());
  $('askBtn').disabled = requestInFlight || !hasQuestion;
  $('askBtn').classList.toggle('hidden', requestInFlight);
  $('stopBtn').classList.toggle('hidden', !requestInFlight);
  $('stopBtn').disabled = !requestInFlight;
  $('newChat').disabled = requestInFlight;
  document.querySelectorAll('.view, .mode, .example').forEach((control) => {
    control.disabled = requestInFlight;
  });
  for (const id of ['llmModel', 'orchestratorPrompt', 'resetSystemPrompt', 'agentId', 'listAgents', 'uriInput', 'webGrounding', 'multiturn', 'stream', 'chatWithAgent', 'contextToggle']) {
    const control = $(id);
    if (control) control.disabled = requestInFlight || (id === 'stream' && view === 'direct' && mode === 'mcp');
  }
  $('composerStatus').textContent =
    message || (requestInFlight ? 'Request in progress…' : hasQuestion ? 'Ready to send.' : 'Enter a prompt to begin.');
}

async function ask() {
  if (requestInFlight) return;
  const question = $('question').value.trim();
  if (!question) {
    updateComposerState('Enter a prompt before sending.');
    $('question').focus();
    return;
  }

  const btn = $('askBtn');
  requestInFlight = true;
  requestAbortReason = null;
  activeRequestController = new AbortController();
  activeRequestTimeout = setTimeout(() => {
    requestAbortReason = 'timeout';
    activeRequestController?.abort();
  }, REQUEST_TIMEOUT_MS);
  btn.classList.add('loading');
  updateComposerState();

  const isAgent = view === 'agent';
  const reqMode = isAgent ? 'llm' : mode;
  const multiturn = $('multiturn').checked;
  // Every request uses SSE for safe live execution events. This flag controls
  // only whether the answer content uses the protocol's streaming operation.
  const streamResponse = $('stream').checked && !(view === 'direct' && mode === 'mcp');
  // Single-turn: each ask is a fresh exchange, so reset the transcript.
  if (!multiturn) clearChat();

  appendUserBubble(question);
  $('question').value = '';
  const bubble = appendAssistantBubble(reqMode);

  const payload = {
    mode: reqMode,
    question,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    streamResponse,
  };

  if (isAgent) {
    payload.backends = orderedAgentBackends();
    payload.model = currentModel;
    if (currentSystemPrompt.trim()) payload.systemPrompt = currentSystemPrompt;
    if (multiturn) {
      payload.history = agentHistory.slice(-12);
      payload.backendConversationIds = { ...agentConversationIds };
    }
    const agentId = $('agentId').value.trim();
    if (agentId && (agentBackends.has('mcp') || agentBackends.has('a2a'))) payload.agentId = agentId;
    // URL context applies to REST and MCP ask; the web toggle is REST-only.
    if (agentBackends.has('rest') || agentBackends.has('mcp')) {
      flushPendingUri();
      if (attachments.uris.length) payload.files = attachments.uris.map((uri) => ({ uri }));
    }
    if (agentBackends.has('rest')) {
      payload.webEnabled = $('webGrounding')?.checked !== false;
    }
  } else {
    if (multiturn && conversationIds[mode]) payload.conversationId = conversationIds[mode];
    if (mode === 'a2a' || mode === 'mcp') {
      const agentId = $('agentId').value.trim();
      if (agentId) payload.agentId = agentId;
    }
    // URL context applies to REST and MCP ask.
    if (mode === 'rest' || mode === 'mcp') {
      flushPendingUri();
      if (attachments.uris.length) payload.files = attachments.uris.map((uri) => ({ uri }));
    }
    if (mode === 'rest') {
      payload.webEnabled = $('webGrounding')?.checked !== false;
    }
  }

  beginPipeline(payload, multiturn);

  try {
    const succeeded = await askStreaming(bubble, payload, multiturn, activeRequestController.signal);
    if (succeeded && isAgent && multiturn) {
      const answerText = bubble.querySelector('.msg-body')?.innerText || '';
      agentHistory.push({ role: 'user', content: question });
      if (answerText) agentHistory.push({ role: 'assistant', content: answerText });
    }
    if (succeeded) clearAttachments();
  } catch (e) {
    if (e.name === 'AbortError' && requestAbortReason === 'stopped') {
      fillAssistantStopped(bubble);
    } else {
      const message =
        e.name === 'AbortError' ? 'The request timed out. Check the connection and try again.' : e.message;
      fillAssistantError(bubble, message);
    }
  } finally {
    clearTimeout(activeRequestTimeout);
    activeRequestTimeout = null;
    activeRequestController = null;
    requestAbortReason = null;
    requestInFlight = false;
    btn.classList.remove('loading');
    updateComposerState();
    refreshStatus();
  }
}

function retainConversationState(payload, data, multiturn) {
  if (payload.mode === 'llm') {
    for (const backend of ['rest', 'a2a', 'mcp']) {
      agentConversationIds[backend] = multiturn ? data.backendConversationIds?.[backend] || null : null;
    }
    return;
  }
  conversationIds[payload.mode] = multiturn ? data.conversationId : null;
}

async function askStreaming(bubble, payload, multiturn, signal) {
  const r = await fetch('/api/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    // Token/validation failures come back as JSON before the SSE stream begins.
    const ctype = r.headers.get('content-type') || '';
    if (!r.ok || ctype.includes('application/json')) {
      const data = await r.json().catch(() => ({ error: `Request failed (${r.status})` }));
      if (data.needsLogin) {
        fillAssistantError(bubble, 'You need to sign in first. Redirecting to sign-in…', data);
        setTimeout(() => (window.location.href = '/auth/login'), 900);
      } else {
        fillAssistantError(bubble, data.error || 'Request failed', data);
      }
      return false;
    }
    if (!r.body) throw new Error('The server returned an empty response stream.');

    const state = { text: '' };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outcome = null;

    const handle = (event, data) => {
      if (event === 'delta') {
        streamAppendDelta(bubble, state, data);
      } else if (event === 'status') {
        streamStatus(bubble, data);
      } else if (event === 'agent_step') {
        liveAgentStep(bubble, data);
      } else if (event === 'tool_result') {
        liveToolResult(bubble, data);
      } else if (event === 'tool_stream') {
        liveToolStream(bubble, data);
      } else if (event === 'trace_step') {
        liveTraceStep(bubble, data);
      } else if (event === 'lifecycle') {
        lifecycleEvent(data);
      } else if (event === 'result') {
        retainConversationState(payload, data, multiturn);
        fillAssistant(bubble, { ...data, streamed: Boolean(data.responseStreamed) });
        outcome = true;
      } else if (event === 'error') {
        if (data.needsLogin) {
          fillAssistantError(bubble, 'You need to sign in first. Redirecting to sign-in…', data);
          setTimeout(() => (window.location.href = '/auth/login'), 900);
        } else {
          fillAssistantError(bubble, data.error || 'Stream failed', data);
        }
        outcome = false;
      }
    };

    const parseRecord = (raw) => {
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return;
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        // A malformed record is ignored; a missing terminal result is surfaced below.
        return;
      }
      handle(event, data);
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        parseRecord(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseRecord(buffer);

    if (outcome === null) throw new Error('The response stream ended before a final result was received.');
    return outcome;
}

$('askBtn').addEventListener('click', ask);
$('stopBtn').addEventListener('click', () => {
  if (!requestInFlight || !activeRequestController) return;
  requestAbortReason = 'stopped';
  $('composerStatus').textContent = 'Stopping response…';
  $('stopBtn').disabled = true;
  activeRequestController.abort();
});

const questionEl = $('question');
questionEl.addEventListener('input', () => updateComposerState());
questionEl.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  // Enter sends; Shift+Enter inserts a newline (Copilot behaviour).
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask();
  }
});

function applyStoryRoute(chip) {
  if (chip.dataset.routeView === 'agent') {
    const backends = (chip.dataset.backends || '')
      .split(',')
      .map((backend) => backend.trim())
      .filter((backend) => ['rest', 'a2a', 'mcp'].includes(backend));
    agentBackends.clear();
    backends.forEach((backend) => agentBackends.add(backend));
    if (agentBackends.size === 0) agentBackends.add('mcp');
    setView('agent', { explicit: true });
    return;
  }

  const storyMode = chip.dataset.routeMode;
  setView('direct', { explicit: true });
  if (['rest', 'a2a', 'mcp'].includes(storyMode)) setMode(storyMode);
}

// Guided stories set their documented route, then run the customer-ready prompt.
const examples = $('examples');
if (examples) {
  examples.addEventListener('click', (e) => {
    const chip = e.target.closest('.example');
    if (!chip) return;
    applyStoryRoute(chip);
    questionEl.value = chip.dataset.prompt || chip.textContent.trim();
    ask();
  });
}

$('newChat').addEventListener('click', clearChat);
$('multiturn').addEventListener('change', updateContinuationPreview);
$('closeAdvancedSetup')?.addEventListener('click', () => {
  $('advancedSetup').open = false;
  $('advancedSetupSummary')?.focus();
});
$('signout').addEventListener('click', async () => {
  await fetch('/api/signout', { method: 'POST' });
  discoveredAgents = null;
  agentDiscoveryAttempted = false;
  mcpToolNames = null;
  mcpToolDiscoveryError = 'Sign in to discover the current MCP tool surface.';
  renderMcpToolSurface();
  window.dispatchEvent(new CustomEvent('workiq:agents', { detail: { agents: [] } }));
  renderAgentDiscovery();
  clearChat();
  refreshStatus();
});

// Initialise to the configured default without overwriting a route the user already selected.
mode = 'rest';
setView('agent');
Promise.allSettled([loadLlmConfig(), loadLabConfig()]).then(([llmResult]) => {
  const agentConfigured = llmResult.status === 'fulfilled' && llmResult.value;
  if (!callerSelectionExplicit) {
    setView(agentConfigured ? 'agent' : 'direct');
  } else if (!agentConfigured && view === 'agent') {
    setView('direct');
  }
});
resetPipeline();
updateComposerState();
refreshStatus();
setInterval(refreshStatus, 5000);
