(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('experimentPanel');
  const status = $('experimentStatus');
  if (!panel || !status) return;

  const CAPABILITIES = [
    ['messaging', 'Messaging'],
    ['streaming', 'Response streaming'],
    ['continuation', 'Native continuation'],
    ['citations', 'Structured citations'],
    ['agentRouting', 'Specific agent routing'],
    ['fileContext', 'File URL context'],
    ['webGrounding', 'Web grounding'],
    ['agentDiscovery', 'Agent discovery'],
    ['agentCards', 'Agent Cards'],
    ['cancellation', 'Request cancellation'],
    ['rawEventVisibility', 'Protocol event visibility'],
  ];
  const PROTOCOLS = ['rest', 'a2a', 'mcp'];
  const state = {
    activeTab: 'compare',
    activeController: null,
    activeRun: null,
    runs: [],
    selectedRunId: null,
    card: null,
    cardError: null,
    availableAgents: [],
    agentsLoading: false,
    agentsError: '',
    capabilities: null,
    capabilitiesError: null,
    compare: {
      prompt: 'Summarize my most recent customer-related work and identify the next action I should take.',
      protocols: new Set(['rest', 'a2a']),
      streaming: true,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    inspector: {
      prompt: 'What are the most important work items I should focus on today?',
      protocol: 'rest',
      filter: 'all',
    },
    context: {
      prompt: 'Based on the available context, what should I do next?',
      protocol: 'rest',
      variants: new Set(['web']),
      fileUrl: '',
      agentId: '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      latitude: '',
      longitude: '',
      countryOrRegion: '',
      countryOrRegionConfidence: '',
      additionalContextText: '',
      additionalContextDescription: '',
    },
    cardAgentId: '',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.classList.toggle('running', kind === 'running');
    status.classList.toggle('error', kind === 'error');
  }

  function protocolLabel(protocol) {
    return String(protocol || '').toUpperCase();
  }

  function shortId(value) {
    const text = String(value || '');
    return text.length > 15 ? `${text.slice(0, 11)}…` : text;
  }

  function normalizeEvent(eventName, data) {
    const candidate =
      eventName === 'protocol_event' && data?.event && typeof data.event === 'object'
        ? { ...data.event, targetId: data.targetId || data.event.targetId, protocol: data.protocol || data.event.protocol }
        : { ...(data || {}) };
    const kind = candidate.kind || candidate.type || candidate.eventType || eventName;
    const direction =
      candidate.direction ||
      candidate.data?.direction ||
      (['request', 'sdk_request'].includes(kind)
        ? 'request'
        : ['response', 'response_headers', 'data', 'error', 'sdk_response', 'sdk_error'].includes(kind)
          ? 'response'
          : 'internal');
    const layer =
      candidate.layer ||
      candidate.data?.layer ||
      (String(kind).startsWith('sdk_')
        ? 'sdk'
        : kind === 'data'
          ? 'sse'
          : ['request', 'response', 'response_headers', 'error', 'complete'].includes(kind)
            ? 'http'
            : 'app');
    return {
      eventName,
      sequence: candidate.sequence ?? candidate.seq ?? 0,
      atMs: candidate.atMs ?? candidate.timestampMs ?? candidate.ts ?? 0,
      targetId: candidate.targetId || candidate.id || '',
      protocol: candidate.protocol || '',
      direction,
      layer,
      type: kind,
      payload: candidate.payload ?? candidate.data ?? candidate,
      truncated: Boolean(candidate.truncated || candidate.data?._truncated),
    };
  }

  async function postSse(url, body, { signal, onEvent, terminalEvents = [] }) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    if (!response.body) throw new Error('The server returned an empty event stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminalSeen = terminalEvents.length === 0;
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
        data = { raw: dataLines.join('\n'), malformed: true };
      }
      if (terminalEvents.includes(event)) terminalSeen = true;
      onEvent(event, data);
      if (event === 'error' && !terminalEvents.includes('error')) {
        throw new Error(data.error || data.message || 'The server reported an experiment error.');
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = buffer.match(/\r?\n\r?\n/))) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        parseRecord(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseRecord(buffer);
    if (!terminalSeen) {
      throw new Error(`The event stream ended before ${terminalEvents.join(' or ')} was received.`);
    }
  }

  function createRun(kind, prompt, targets, streaming) {
    const run = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      kind,
      prompt,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'running',
      streaming,
      result: null,
      events: [],
      targets: Object.fromEntries(
        targets.map((target) => [
          target.id,
          {
            id: target.id,
            protocol: target.protocol,
            label: target.label || protocolLabel(target.protocol),
            summary: target.summary || '',
            status: 'queued',
            events: [],
            result: null,
            error: null,
            liveAnswer: '',
            hasLiveResponse: false,
          },
        ])
      ),
    };
    state.runs.unshift(run);
    state.runs = state.runs.slice(0, 20);
    state.selectedRunId = run.id;
    return run;
  }

  function targetFor(run, data) {
    const id = data?.targetId || data?.id;
    if (id && run.targets[id]) return run.targets[id];
    const protocol = data?.protocol;
    return Object.values(run.targets).find((target) => target.protocol === protocol) || null;
  }

  function handleRunEvent(run, eventName, data) {
    const capturedEvent = normalizeEvent(eventName, data);
    run.events.push(capturedEvent);
    const eventTarget = targetFor(run, capturedEvent);
    if (eventTarget) eventTarget.events.push(capturedEvent);

    if (eventName === 'target_start') {
      const target = targetFor(run, data);
      if (target) target.status = 'running';
      return;
    }
    if (eventName === 'protocol_event') {
      const target = targetFor(run, capturedEvent);
      if (target) {
        target.status = 'running';
      }
      return;
    }
    if (eventName === 'target_delta') {
      const target = targetFor(run, data);
      if (!target || typeof data?.text !== 'string') return;
      target.status = 'running';
      target.liveAnswer = data.replace === true ? data.text : target.liveAnswer + data.text;
      target.hasLiveResponse = true;
      return;
    }
    if (eventName === 'target_result') {
      const target = targetFor(run, data);
      if (!target) return;
      const result = data.result && typeof data.result === 'object' ? { ...data.result } : { ...data };
      if (data.metrics && !result.metrics) result.metrics = data.metrics;
      target.status = 'complete';
      target.result = result;
      return;
    }
    if (eventName === 'target_error') {
      const target = targetFor(run, data);
      if (!target) return;
      target.status = 'error';
      target.error = data.error || data.message || 'Target failed';
      if (data.metrics) target.result = { metrics: data.metrics };
      return;
    }
    if (eventName === 'run_result') {
      run.status = data.status || (Object.values(run.targets).some((target) => target.status === 'error') ? 'partial' : 'complete');
      run.completedAt = new Date().toISOString();
      run.result = data;
    }
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderActiveTab();
    }, 80);
  }

  async function executeRun({ kind, prompt, targets, streaming }) {
    if (state.activeController) {
      setStatus('Stop the active experiment before starting another.', 'error');
      return;
    }
    if (targets.length > 1) {
      const confirmed = window.confirm(
        `This experiment sends ${targets.length} separate, potentially billable Work IQ requests. Continue?`
      );
      if (!confirmed) return;
    }

    const run = createRun(kind, prompt, targets, streaming);
    const controller = new AbortController();
    state.activeController = controller;
    state.activeRun = run;
    setStatus(`Running ${targets.length} bounded ${targets.length === 1 ? 'request' : 'requests'}…`, 'running');
    renderActiveTab();

    try {
      await postSse(
        '/api/lab/experiments/stream',
        {
          kind,
          prompt,
          targets: targets.map(({ label, summary, ...target }) => target),
          ...(typeof streaming === 'boolean' ? { streaming } : {}),
        },
        {
          signal: controller.signal,
          terminalEvents: ['run_result'],
          onEvent: (eventName, data) => {
            handleRunEvent(run, eventName, data);
            scheduleRender();
          },
        }
      );
      if (run.status === 'running') {
        run.status = Object.values(run.targets).some((target) => target.status === 'error') ? 'partial' : 'complete';
        run.completedAt = new Date().toISOString();
      }
      setStatus(
        run.status === 'partial' ? 'Experiment completed with one or more failed targets.' : 'Experiment completed.',
        run.status === 'partial' ? 'error' : ''
      );
    } catch (error) {
      run.status = error.name === 'AbortError' ? 'stopped' : 'error';
      run.completedAt = new Date().toISOString();
      setStatus(error.name === 'AbortError' ? 'Experiment stopped.' : error.message, error.name === 'AbortError' ? '' : 'error');
    } finally {
      state.activeController = null;
      state.activeRun = null;
      renderActiveTab();
    }
  }

  function resultMetrics(target) {
    const result = target?.result;
    if (!result) return {};
    return result.metrics || result.performance || result;
  }

  function formatMs(value) {
    return value != null && Number.isFinite(Number(value))
      ? `${Math.round(Number(value)).toLocaleString()} ms`
      : '—';
  }

  function sourceHtml(sources) {
    if (!Array.isArray(sources) || !sources.length) return '';
    return `<div class="exp-refs"><strong>${sources.length} reference${sources.length === 1 ? '' : 's'}</strong>${sources
      .map((source) => {
        const title = source.title || source.name || source.url || 'Source';
        const url = safeHttpUrl(source.url);
        return url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
          : `<span>${escapeHtml(title)}</span>`;
      })
      .join('')}</div>`;
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function targetResultsHtml(run) {
    if (!run) return '<div class="exp-empty">Run an experiment to populate results.</div>';
    return `<div class="exp-results">${Object.values(run.targets)
      .map((target) => {
        const metrics = resultMetrics(target);
        const result = target.result || {};
        const timings = metrics.timings || result.timings || {};
        const isLive = target.status === 'running' && target.hasLiveResponse;
        const answer =
          typeof result.answer === 'string'
            ? result.answer
            : isLive
              ? target.liveAnswer
              : target.status === 'running'
                ? 'Waiting for the response…'
                : '';
        const displayAnswer = window.WorkIqAnswerFormatter?.normalize(answer) ?? answer;
        const answerState = isLive ? 'Streaming response' : target.status === 'running' ? 'Response pending' : 'Full response';
        const badgeClass = target.status === 'complete' ? 'ok' : target.status === 'error' ? 'bad' : 'warn';
        const responseMode = metrics.responseMode || result.responseMode;
        const firstResponseLabel = responseMode === 'streaming' ? 'Prompt → first' : 'Prompt → full';
        const requestedTimeZone = metrics.context?.requestedTimeZone || result.context?.requestedTimeZone;
        const appliedTimeZone = metrics.context?.appliedTimeZone || result.context?.appliedTimeZone;
        const sourceStatus = result.sourcesStatus || metrics.sourcesStatus;
        const eventCount = metrics.eventCount ?? target.events.length;
        const sourceCount = metrics.sourceCount ?? result.sources?.length ?? 0;
        return `<article class="exp-result${target.status === 'error' ? ' is-error' : ''}">
          <div class="exp-result-head">
            <strong>${escapeHtml(target.label)}</strong>
            <span class="exp-badge ${badgeClass}">${escapeHtml(target.status)}</span>
          </div>
          <div class="exp-result-body">
            ${target.summary ? `<p class="exp-result-context">${escapeHtml(target.summary)}</p>` : ''}
            <div class="exp-metrics">
              <div class="exp-metric"><span>Preparation</span><strong>${formatMs(timings.preparationMs)}</strong></div>
              <div class="exp-metric"><span>Barrier wait</span><strong>${formatMs(timings.barrierWaitMs)}</strong></div>
              <div class="exp-metric"><span>${firstResponseLabel}</span><strong>${formatMs(timings.promptToFirstResponseMs)}</strong></div>
              <div class="exp-metric"><span>Stream delivery</span><strong>${
                responseMode === 'streaming' ? formatMs(timings.responseDeliveryMs) : 'N/A'
              }</strong></div>
              <div class="exp-metric"><span>Prompt → complete</span><strong>${formatMs(timings.promptToCompleteMs)}</strong></div>
              <div class="exp-metric"><span>End-to-end</span><strong>${formatMs(timings.totalMs ?? metrics.totalMs)}</strong></div>
            </div>
            ${
              target.status === 'complete'
                ? `<div class="exp-callout"><strong>Actual route</strong><br>${escapeHtml(
                    metrics.operation || result.operation || `${protocolLabel(target.protocol)} request`
                  )} · ${responseMode === 'streaming' ? 'streaming response' : 'terminal response'}<br>Time zone: ${
                    appliedTimeZone
                      ? `${escapeHtml(appliedTimeZone)} applied`
                      : requestedTimeZone
                        ? `${escapeHtml(requestedTimeZone)} requested but not exposed by this contract`
                        : 'not requested'
                  }<br><span class="exp-evidence">${eventCount} protocol-specific diagnostic events · ${
                    sourceStatus === 'unavailable'
                      ? escapeHtml(result.sourceNote || 'Structured citations are not exposed by this response contract.')
                      : `${sourceCount} structured source${sourceCount === 1 ? '' : 's'} returned`
                  }</span></div>`
                : ''
            }
            ${
              target.error
                ? `<div class="exp-callout bad">${escapeHtml(target.error)}</div>`
                : `<div class="exp-answer-meta">${answerState} · ${answer.length.toLocaleString()} characters</div><div class="exp-answer${
                    isLive ? ' is-streaming' : ''
                  }" role="status" aria-live="polite">${escapeHtml(displayAnswer)}</div>${sourceHtml(result.sources)}`
            }
            ${
              result.conversationId || result.taskId
                ? `<div class="exp-callout"><strong>Identifiers</strong><br>${result.conversationId ? `Context: ${escapeHtml(result.conversationId)}` : ''}${
                    result.taskId ? `<br>Task: ${escapeHtml(result.taskId)}` : ''
                  }</div>`
                : ''
            }
          </div>
        </article>`;
      })
      .join('')}</div>`;
  }

  function selectedRun(kind) {
    const selected = state.runs.find((run) => run.id === state.selectedRunId);
    if (selected && (!kind || selected.kind === kind)) return selected;
    return state.runs.find((run) => !kind || run.kind === kind) || null;
  }

  function runChipsHtml() {
    if (!state.runs.length) return '';
    return `<div class="exp-run-list">${state.runs
      .map(
        (run) =>
          `<button type="button" class="exp-run-chip${run.id === state.selectedRunId ? ' active' : ''}" data-run-id="${escapeHtml(
            run.id
          )}">${escapeHtml(run.kind)} · ${escapeHtml(new Date(run.startedAt).toLocaleTimeString())} · ${escapeHtml(run.status)}</button>`
      )
      .join('')}</div>`;
  }

  function bindRunChips() {
    panel.querySelectorAll('[data-run-id]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedRunId = button.dataset.runId;
        renderActiveTab();
      });
    });
  }

  function renderCompare() {
    const run = selectedRun('comparison');
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Protocol comparison</h3><p>Send one prompt through multiple direct protocols at the same time. Every lane is prepared before dispatch, isolated, and reports its actual route.</p></div>
      </div>
      <div class="exp-card">
        <div class="exp-form">
          <label class="exp-field"><span>Prompt</span><textarea id="comparePrompt">${escapeHtml(state.compare.prompt)}</textarea></label>
          <div>
            <span class="exp-label">Direct protocols</span>
            <div class="exp-choices">
              ${PROTOCOLS.map(
                (protocol) =>
                  `<label class="exp-choice"><input type="checkbox" data-compare-protocol="${protocol}" ${
                    state.compare.protocols.has(protocol) ? 'checked' : ''
                  }> ${protocolLabel(protocol)}${protocol === 'mcp' ? ' · single result' : ' · supports streaming'}</label>`
              ).join('')}
            </div>
          </div>
          <div>
            <span class="exp-label">Response mode</span>
            <div class="exp-choices">
              <label class="exp-choice"><input id="compareStreaming" type="checkbox" ${
                state.compare.streaming ? 'checked' : ''
              }> Stream responses live <span class="exp-choice-note">REST and A2A</span></label>
            </div>
            <p class="exp-evidence">This changes the Work IQ operation itself: on uses REST <code>chatOverStream</code> and A2A <code>SendStreamingMessage</code>; off uses REST <code>chat</code> and A2A <code>SendMessage</code>. MCP is terminal in both cases.</p>
          </div>
          <div class="exp-actions">
            <button id="runCompare" class="exp-button" type="button" ${state.activeController ? 'disabled' : ''}>Run comparison</button>
            ${state.activeController ? '<button id="stopExperiment" class="exp-button danger" type="button">Stop all</button>' : ''}
            <span id="comparePreflight" class="exp-preflight"></span>
          </div>
        </div>
      </div>
      ${runChipsHtml()}
      ${
        run
          ? `<div class="exp-callout warn"><strong>Comparable timing, not identical protocol contracts</strong><br>Protocol-specific setup completes before a shared prompt-dispatch barrier. Dispatch skew: ${
              run.result?.dispatchSkewMs == null
                ? run.status === 'running'
                  ? 'measuring…'
                  : 'not measurable because a lane did not dispatch'
                : formatMs(run.result.dispatchSkewMs)
            }. End-to-end time still includes setup and barrier wait. First-response timing means a stream response for REST/A2A streaming, but the complete tool result for terminal calls. Answer quality can still vary because retrieval and protocol response contracts are not deterministic.</div>
            <div class="exp-callout"><strong>Exact prompt and shared time zone sent to every lane</strong><br>${escapeHtml(
              run.prompt
            )}<br><span class="exp-evidence">Requested time zone: ${escapeHtml(state.compare.timeZone)}. Each result reports whether its protocol contract applied it.</span></div>`
          : ''
      }
      ${targetResultsHtml(run)}
    </section>`;

    const prompt = $('comparePrompt');
    prompt?.addEventListener('input', () => {
      state.compare.prompt = prompt.value;
    });
    panel.querySelectorAll('[data-compare-protocol]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) state.compare.protocols.add(input.dataset.compareProtocol);
        else state.compare.protocols.delete(input.dataset.compareProtocol);
        updateComparePreflight();
      });
    });
    $('compareStreaming')?.addEventListener('change', (event) => {
      state.compare.streaming = event.currentTarget.checked;
      updateComparePreflight();
    });
    $('runCompare')?.addEventListener('click', () => {
      const protocols = PROTOCOLS.filter((protocol) => state.compare.protocols.has(protocol));
      if (!state.compare.prompt.trim()) return setStatus('Enter a comparison prompt.', 'error');
      if (protocols.length < 2 || protocols.length > 3) return setStatus('Choose two or three protocols.', 'error');
      executeRun({
        kind: 'comparison',
        prompt: state.compare.prompt.trim(),
        targets: protocols.map((protocol) => ({
          id: protocol,
          protocol,
          label: protocolLabel(protocol),
          timeZone: state.compare.timeZone,
        })),
        streaming: state.compare.streaming,
      });
    });
    $('stopExperiment')?.addEventListener('click', () => state.activeController?.abort());
    bindRunChips();
    updateComparePreflight();
  }

  function updateComparePreflight() {
    const count = state.compare.protocols.size;
    const preflight = $('comparePreflight');
    if (preflight) {
      preflight.textContent =
        count >= 2
          ? `${count} separate Work IQ calls · ${
              state.compare.streaming
                ? 'REST/A2A streaming operations; MCP terminal'
                : 'terminal REST, A2A, and MCP operations'
            } · shared ${state.compare.timeZone} time zone. Chat/Context credits are variable and not returned per request.`
          : 'Choose at least two protocols.';
    }
  }

  function filteredEvents(run) {
    if (!run) return [];
    const filter = state.inspector.filter;
    if (filter === 'all') return run.events;
    return run.events.filter(
      (event) =>
        event.direction === filter ||
        event.layer === filter ||
        event.protocol === filter ||
        event.type === filter ||
        event.eventName === filter
    );
  }

  function eventListHtml(run) {
    const events = filteredEvents(run);
    if (!run) return '<div class="exp-empty">Run or select an experiment to inspect its events.</div>';
    if (!events.length) return '<div class="exp-empty">No events match this filter.</div>';
    return `<div class="exp-event-list">${events
      .map(
        (event) => `<div class="exp-event">
          <time>+${escapeHtml(event.atMs)} ms</time>
          <span class="direction">${escapeHtml(event.direction)}</span>
          <span class="event-type">${escapeHtml(
            [event.protocol, event.layer].filter(Boolean).map(protocolLabel).join(' · ')
          )}</span>
          <details>
            <summary>${escapeHtml(event.type)}${event.truncated ? ' · truncated' : ''}</summary>
            <pre>${escapeHtml(safeJson(event.payload))}</pre>
          </details>
        </div>`
      )
      .join('')}</div>`;
  }

  function renderInspector() {
    const run = selectedRun();
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Live protocol inspector</h3><p>See the ordered requests, responses, SSE records, SDK-level MCP calls, normalized events, and timings behind a direct request.</p></div>
      </div>
      <div class="exp-card">
        <div class="exp-form">
          <div class="exp-grid">
            <label class="exp-field"><span>Protocol</span><select id="inspectProtocol">${PROTOCOLS.map(
              (protocol) => `<option value="${protocol}" ${state.inspector.protocol === protocol ? 'selected' : ''}>${protocolLabel(protocol)}</option>`
            ).join('')}</select></label>
            <label class="exp-field"><span>Event filter</span><select id="eventFilter">
              ${['all', 'request', 'response', 'internal', 'http', 'sse', 'rest', 'a2a', 'mcp'].map(
                (filter) => `<option value="${filter}" ${state.inspector.filter === filter ? 'selected' : ''}>${filter}</option>`
              ).join('')}
            </select></label>
          </div>
          <label class="exp-field"><span>Prompt</span><textarea id="inspectPrompt">${escapeHtml(state.inspector.prompt)}</textarea></label>
          <div class="exp-actions">
            <button id="runInspect" class="exp-button" type="button" ${state.activeController ? 'disabled' : ''}>Run inspected request</button>
            ${state.activeController ? '<button id="stopExperiment" class="exp-button danger" type="button">Stop</button>' : ''}
            <button id="exportRun" class="exp-button secondary" type="button" ${run ? '' : 'disabled'}>Export selected run</button>
            <span class="exp-preflight">One potentially billable direct request. MCP visibility is SDK-level, not raw wire frames.</span>
          </div>
        </div>
      </div>
      ${runChipsHtml()}
      ${eventListHtml(run)}
    </section>`;

    $('inspectProtocol')?.addEventListener('change', (event) => {
      state.inspector.protocol = event.target.value;
    });
    $('inspectPrompt')?.addEventListener('input', (event) => {
      state.inspector.prompt = event.target.value;
    });
    $('eventFilter')?.addEventListener('change', (event) => {
      state.inspector.filter = event.target.value;
      renderInspector();
    });
    $('runInspect')?.addEventListener('click', () => {
      if (!state.inspector.prompt.trim()) return setStatus('Enter an inspector prompt.', 'error');
      executeRun({
        kind: 'inspect',
        prompt: state.inspector.prompt.trim(),
        targets: [{ id: `inspect-${state.inspector.protocol}`, protocol: state.inspector.protocol, label: protocolLabel(state.inspector.protocol) }],
      });
    });
    $('stopExperiment')?.addEventListener('click', () => state.activeController?.abort());
    $('exportRun')?.addEventListener('click', () => run && downloadJson(`workiq-run-${run.id}.json`, run));
    bindRunChips();
  }

  function downloadJson(filename, value) {
    const confirmed = window.confirm(
      'This local JSON export can contain prompts, answers, source metadata, and task identifiers from the customer tenant. Download it?'
    );
    if (!confirmed) return;
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Downloaded locally. Review the file before sharing because it may contain work data.');
  }

  function cardField(card, ...keys) {
    for (const key of keys) {
      if (card?.[key] != null) return card[key];
    }
    return null;
  }

  function cardProvider(card) {
    const provider = cardField(card, 'provider');
    if (typeof provider === 'string') return provider;
    return provider?.organization || provider?.name || 'not declared';
  }

  function syncAvailableAgents(agents) {
    state.availableAgents = Array.isArray(agents) ? agents.map((agent) => ({ ...agent })) : [];
    state.agentsError = '';
  }

  async function loadAvailableAgents({ force = false } = {}) {
    const shared = window.workIqLabState;
    const snapshot = shared?.snapshot?.() || {};
    if (!force && (snapshot.discoveredAgents?.length || snapshot.agentDiscoveryAttempted)) {
      syncAvailableAgents(snapshot.discoveredAgents);
      return state.availableAgents;
    }
    if (typeof shared?.discoverAgents !== 'function' || state.agentsLoading) return state.availableAgents;

    state.agentsLoading = true;
    state.agentsError = '';
    if (state.activeTab === 'cards') renderCards();
    try {
      syncAvailableAgents(await shared.discoverAgents({ force }));
    } catch (error) {
      state.agentsError = error.message;
    } finally {
      state.agentsLoading = false;
      if (state.activeTab === 'cards') renderCards();
    }
    return state.availableAgents;
  }

  function agentCardOptions() {
    const options = [{ agentId: '', name: 'Default Work IQ agent' }, ...state.availableAgents];
    if (state.cardAgentId && !options.some((agent) => agent.agentId === state.cardAgentId)) {
      options.push({ agentId: state.cardAgentId, name: state.cardAgentId });
    }
    return options
      .map((agent) => {
        const id = agent.agentId || '';
        const provider = agent.provider ? ` · ${agent.provider}` : '';
        return `<option value="${escapeHtml(id)}" ${id === state.cardAgentId ? 'selected' : ''}>${escapeHtml(
          agent.name || id || 'Default Work IQ agent'
        )}${escapeHtml(provider)}</option>`;
      })
      .join('');
  }

  function renderCards() {
    const card = state.card?.card || state.card;
    const skills = cardField(card, 'skills') || [];
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Agent Card explorer</h3><p>Inspect the default Work IQ A2A Agent Card or a specific discovered agent without allowing arbitrary URLs.</p></div>
      </div>
      <div class="exp-card">
        <div class="exp-form">
          <div class="exp-grid">
            <label class="exp-field"><span>Available agent</span><select id="cardAgentId">${agentCardOptions()}</select><small>${
              state.agentsLoading
                ? 'Discovering agents…'
                : state.agentsError
                  ? escapeHtml(state.agentsError)
                  : 'Uses the agent list already discovered by the Conversation workspace.'
            }</small></label>
            <div class="exp-actions">
              <button id="loadCard" class="exp-button" type="button">Load Agent Card</button>
              <button id="refreshCardAgents" class="exp-button secondary" type="button" ${
                state.agentsLoading ? 'disabled' : ''
              }>Refresh agents</button>
            </div>
          </div>
        </div>
      </div>
      ${
        state.cardError
          ? `<div class="exp-callout bad">${escapeHtml(state.cardError)}</div>`
          : card
            ? `<div class="exp-grid">
                <article class="exp-card">
                  <span class="eyebrow">Identity</span>
                  <h3>${escapeHtml(cardField(card, 'name') || 'Unnamed agent')}</h3>
                  <p>${escapeHtml(cardField(card, 'description') || 'No description returned.')}</p>
                  <div class="exp-callout">
                    Protocol: ${escapeHtml(cardField(card, 'protocolVersion', 'version') || 'not declared')}<br>
                    Provider: ${escapeHtml(cardProvider(card))}<br>
                    Input modes: ${escapeHtml((cardField(card, 'defaultInputModes', 'inputModes') || []).join(', ') || 'not declared')}<br>
                    Output modes: ${escapeHtml((cardField(card, 'defaultOutputModes', 'outputModes') || []).join(', ') || 'not declared')}
                  </div>
                </article>
                <article class="exp-card">
                  <span class="eyebrow">Capabilities and skills</span>
                  <pre class="exp-json">${escapeHtml(safeJson(cardField(card, 'capabilities') || {}))}</pre>
                  ${
                    Array.isArray(skills) && skills.length
                      ? skills
                          .map(
                            (skill) =>
                              `<div class="exp-callout"><strong>${escapeHtml(skill.name || skill.id || 'Skill')}</strong><br>${escapeHtml(
                                skill.description || ''
                              )}</div>`
                          )
                          .join('')
                      : '<p>No skills were declared.</p>'
                  }
                </article>
              </div>
              <details class="exp-card"><summary>Raw Agent Card JSON</summary><pre class="exp-json">${escapeHtml(safeJson(card))}</pre></details>`
            : '<div class="exp-empty">Load an Agent Card to inspect its declared capabilities and raw JSON.</div>'
      }
    </section>`;

    $('cardAgentId')?.addEventListener('change', (event) => {
      state.cardAgentId = event.target.value;
    });
    $('loadCard')?.addEventListener('click', loadCard);
    $('refreshCardAgents')?.addEventListener('click', () => loadAvailableAgents({ force: true }));
  }

  async function loadCard() {
    setStatus('Loading the fixed-host Work IQ Agent Card…', 'running');
    state.cardError = null;
    try {
      const query = state.cardAgentId.trim() ? `?agentId=${encodeURIComponent(state.cardAgentId.trim())}` : '';
      const response = await fetch(`/api/lab/a2a/agent-card${query}`);
      const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      state.card = data;
      setStatus('Agent Card loaded. This metadata request does not send a Work IQ chat prompt.');
    } catch (error) {
      state.cardError = error.message;
      setStatus(error.message, 'error');
    }
    renderCards();
  }

  function contextOptions(protocol) {
    const snapshot = window.workIqLabState?.snapshot?.() || {};
    const continuationId = snapshot.conversationIds?.[protocol] || snapshot.agentConversationIds?.[protocol] || '';
    return [
      {
        id: 'continuation',
        label: 'Reuse native continuation',
        available: Boolean(continuationId),
        detail: continuationId ? `Uses ${shortId(continuationId)} · runs alone` : 'Run a continued conversation first',
      },
      { id: 'web', label: 'Enable web grounding', available: protocol === 'rest', detail: 'REST only' },
      { id: 'file', label: 'Add file URL', available: protocol === 'rest' || protocol === 'mcp', detail: 'Requires an HTTPS URL' },
      { id: 'agent', label: 'Specific agent', available: protocol === 'a2a' || protocol === 'mcp', detail: 'Requires an agent ID' },
      { id: 'location', label: 'Add geographic location', available: protocol === 'rest', detail: 'REST only · latitude/longitude or country' },
      { id: 'additional', label: 'Add text context', available: protocol === 'rest', detail: 'REST only · text plus optional label' },
    ];
  }

  function selectedContextConfigHtml() {
    const selected = state.context.variants;
    const sections = [];
    if (selected.has('web')) {
      sections.push(
        '<div class="exp-callout" data-context-config="web"><strong>Web grounding enabled</strong><br>No additional value is required. This REST variant sends <code>isWebEnabled: true</code>.</div>'
      );
    }
    if (selected.has('continuation')) {
      sections.push(
        '<div class="exp-callout" data-context-config="continuation"><strong>Native continuation enabled</strong><br>This variant reuses the latest conversation/context ID for the selected protocol.</div>'
      );
    }
    if (selected.has('file')) {
      sections.push(`<div class="exp-variant-config" data-context-config="file">
        <strong>File URL context</strong>
        <label class="exp-field"><span>OneDrive or SharePoint file URL</span><input id="contextFile" type="url" value="${escapeHtml(
          state.context.fileUrl
        )}" placeholder="https://..."><small>Must be an absolute HTTPS URL.</small></label>
      </div>`);
    }
    if (selected.has('agent')) {
      sections.push(`<div class="exp-variant-config" data-context-config="agent">
        <strong>Specific agent routing</strong>
        <label class="exp-field"><span>Agent ID</span><input id="contextAgent" value="${escapeHtml(
          state.context.agentId
        )}" placeholder="Agent ID"><small>Use an agent discovered in the Conversation workspace.</small></label>
      </div>`);
    }
    if (selected.has('location')) {
      sections.push(`<div class="exp-variant-config" data-context-config="location">
        <strong>Geographic location context</strong>
        <p>Provide latitude and longitude together, a two-letter country code, or both.</p>
        <div class="exp-grid three">
          <label class="exp-field"><span>Latitude</span><input id="contextLatitude" type="number" min="-90" max="90" step="any" value="${escapeHtml(
            state.context.latitude
          )}" placeholder="50.8503"></label>
          <label class="exp-field"><span>Longitude</span><input id="contextLongitude" type="number" min="-180" max="180" step="any" value="${escapeHtml(
            state.context.longitude
          )}" placeholder="4.3517"></label>
          <label class="exp-field"><span>Country or region</span><input id="contextCountry" maxlength="2" value="${escapeHtml(
            state.context.countryOrRegion
          )}" placeholder="BE"></label>
          <label class="exp-field"><span>Country confidence</span><input id="contextCountryConfidence" type="number" min="0" max="1" step="0.01" value="${escapeHtml(
            state.context.countryOrRegionConfidence
          )}" placeholder="0.95"><small>Optional, from 0 to 1.</small></label>
        </div>
      </div>`);
    }
    if (selected.has('additional')) {
      sections.push(`<div class="exp-variant-config" data-context-config="additional">
        <strong>Additional text context</strong>
        <div class="exp-grid">
          <label class="exp-field"><span>Context label</span><input id="contextAdditionalDescription" maxlength="200" value="${escapeHtml(
            state.context.additionalContextDescription
          )}" placeholder="Experiment assumption"></label>
          <label class="exp-field"><span>Context text</span><textarea id="contextAdditionalText" maxlength="4000" placeholder="Text to ground this REST request">${escapeHtml(
            state.context.additionalContextText
          )}</textarea></label>
        </div>
      </div>`);
    }
    return sections.join('');
  }

  function renderContext() {
    const run = selectedRun('context');
    const options = contextOptions(state.context.protocol);
    const selectedOptions = options.filter((option) => state.context.variants.has(option.id));
    const callCount = 2 ** selectedOptions.length;
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Context experiment builder</h3><p>Run every on/off combination of the selected context settings so you can see which setting, or interaction between settings, changes the answer.</p></div>
      </div>
      <div class="exp-card">
        <div class="exp-form">
          <div class="exp-grid">
            <label class="exp-field"><span>Protocol</span><select id="contextProtocol">${PROTOCOLS.map(
              (protocol) => `<option value="${protocol}" ${state.context.protocol === protocol ? 'selected' : ''}>${protocolLabel(protocol)}</option>`
            ).join('')}</select></label>
            <label class="exp-field"><span>Time zone</span><input id="contextTimeZone" value="${escapeHtml(
              state.context.timeZone
            )}" placeholder="Europe/Brussels"><small>IANA time zone. Required by REST and sent to A2A/MCP when supported.</small></label>
          </div>
          <label class="exp-field"><span>Prompt</span><textarea id="contextPrompt">${escapeHtml(state.context.prompt)}</textarea></label>
          <div>
            <span class="exp-label">Settings to include in the combination matrix</span>
            <div class="exp-choices">
              ${options
                .map(
                  (option) =>
                    `<label class="exp-choice${state.context.variants.has(option.id) ? ' selected' : ''}" title="${escapeHtml(
                      option.detail
                    )}"><input type="checkbox" data-context-variant="${option.id}" ${
                      state.context.variants.has(option.id) ? 'checked' : ''
                    } ${option.available ? '' : 'disabled'}> ${escapeHtml(option.label)} · ${escapeHtml(option.detail)}</label>`
                )
                .join('')}
            </div>
          </div>
          <div class="exp-selection-summary" role="status"><strong>${selectedOptions.length} setting${
            selectedOptions.length === 1 ? '' : 's'
          } selected · ${callCount} combination${callCount === 1 ? '' : 's'} · ${callCount} call${callCount === 1 ? '' : 's'}</strong><span>${
            selectedOptions.length
              ? `Matrix: ${selectedOptions.map((option) => escapeHtml(option.label)).join(' × ')}`
              : 'Choose at least one variant to compare with the fresh baseline.'
          }</span></div>
          <div class="exp-variant-configs">${selectedContextConfigHtml()}</div>
          <div class="exp-actions">
            <button id="runContext" class="exp-button" type="button" ${state.activeController ? 'disabled' : ''}>Run ${callCount} combinations</button>
            ${state.activeController ? '<button id="stopExperiment" class="exp-button danger" type="button">Stop all</button>' : ''}
            <span class="exp-preflight">Full on/off matrix · up to 3 settings · up to 8 potentially billable calls. Native continuation runs alone because each call mutates its conversation.</span>
          </div>
        </div>
      </div>
      <div class="exp-callout"><strong>Date and location behavior</strong><br>There is no separate current-date request field. Work IQ derives “today” and “tomorrow” at request time using the supplied time zone. Only REST documents optional latitude, longitude, country/region, and confidence.</div>
      <div class="exp-table-wrap"><table class="exp-table">
        <thead><tr><th>Caller-supplied context</th><th>REST</th><th>A2A</th><th>MCP ask</th></tr></thead>
        <tbody>
          <tr><td>Time zone</td><td>Required location hint</td><td>Location metadata + UTC offset</td><td>Optional; UTC if omitted</td></tr>
          <tr><td>Latitude / longitude / country</td><td>Supported</td><td>Not documented</td><td>Not documented</td></tr>
          <tr><td>OneDrive / SharePoint file URLs</td><td>Supported</td><td>Not documented</td><td>Supported</td></tr>
          <tr><td>Web grounding toggle</td><td>Supported per turn</td><td>Not documented</td><td>Not documented</td></tr>
          <tr><td>Additional text context</td><td>Supported</td><td>Not documented</td><td>Use prompt text</td></tr>
          <tr><td>Native continuation</td><td>Conversation ID in URL</td><td>Context ID</td><td>Conversation ID</td></tr>
          <tr><td>Specific agent</td><td>Not exposed here</td><td>Agent route</td><td>Agent ID</td></tr>
        </tbody>
      </table></div>
      ${targetResultsHtml(run)}
    </section>`;

    $('contextProtocol')?.addEventListener('change', (event) => {
      state.context.protocol = event.target.value;
      state.context.variants = new Set(
        [...state.context.variants].filter((variant) => contextOptions(state.context.protocol).find((option) => option.id === variant)?.available)
      );
      renderContext();
    });
    $('contextPrompt')?.addEventListener('input', (event) => (state.context.prompt = event.target.value));
    $('contextTimeZone')?.addEventListener('input', (event) => (state.context.timeZone = event.target.value));
    $('contextFile')?.addEventListener('input', (event) => (state.context.fileUrl = event.target.value));
    $('contextAgent')?.addEventListener('input', (event) => (state.context.agentId = event.target.value));
    $('contextLatitude')?.addEventListener('input', (event) => (state.context.latitude = event.target.value));
    $('contextLongitude')?.addEventListener('input', (event) => (state.context.longitude = event.target.value));
    $('contextCountry')?.addEventListener('input', (event) => (state.context.countryOrRegion = event.target.value));
    $('contextCountryConfidence')?.addEventListener(
      'input',
      (event) => (state.context.countryOrRegionConfidence = event.target.value)
    );
    $('contextAdditionalDescription')?.addEventListener(
      'input',
      (event) => (state.context.additionalContextDescription = event.target.value)
    );
    $('contextAdditionalText')?.addEventListener(
      'input',
      (event) => (state.context.additionalContextText = event.target.value)
    );
    panel.querySelectorAll('[data-context-variant]').forEach((input) => {
      input.addEventListener('change', () => {
        const variant = input.dataset.contextVariant;
        if (
          input.checked &&
          (variant === 'continuation' ? state.context.variants.size > 0 : state.context.variants.has('continuation'))
        ) {
          input.checked = false;
          setStatus('Native continuation must run by itself because each request mutates the shared conversation state.', 'error');
        } else if (input.checked && state.context.variants.size >= 3) {
          input.checked = false;
          setStatus('Choose at most three settings. A complete three-setting matrix already sends eight requests.', 'error');
        } else if (input.checked) state.context.variants.add(variant);
        else state.context.variants.delete(variant);
        renderContext();
      });
    });
    $('runContext')?.addEventListener('click', runContext);
    $('stopExperiment')?.addEventListener('click', () => state.activeController?.abort());
  }

  function validHttpsUrl(value) {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  function validTimeZone(value) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }

  function runContext() {
    const protocol = state.context.protocol;
    const prompt = state.context.prompt.trim();
    if (!prompt) return setStatus('Enter a context experiment prompt.', 'error');
    const timeZone = state.context.timeZone.trim();
    if (!timeZone) return setStatus('Enter an IANA time zone.', 'error');
    if (!validTimeZone(timeZone)) return setStatus('Enter a valid IANA time zone, such as Europe/Brussels.', 'error');
    const snapshot = window.workIqLabState?.snapshot?.() || {};
    const continuationId = snapshot.conversationIds?.[protocol] || snapshot.agentConversationIds?.[protocol] || '';
    if (!state.context.variants.size) return setStatus('Choose at least one available context setting.', 'error');
    const variants = [...state.context.variants];
    if (variants.includes('continuation') && variants.length > 1) {
      return setStatus('Native continuation must run by itself because each request mutates the shared conversation state.', 'error');
    }
    if (variants.length > 3) {
      return setStatus('Choose at most three settings so the matrix stays within eight requests.', 'error');
    }
    const optionById = new Map(contextOptions(protocol).map((option) => [option.id, option]));
    const patches = new Map();
    for (const variant of variants) {
      if (variant === 'continuation') {
        if (!continuationId) return setStatus('No native continuation ID is available for this protocol.', 'error');
        patches.set(variant, { conversationId: continuationId });
      } else if (variant === 'web') {
        if (protocol !== 'rest') return setStatus('Web grounding is available only for REST.', 'error');
        patches.set(variant, { webEnabled: true });
      } else if (variant === 'file') {
        if (!validHttpsUrl(state.context.fileUrl)) return setStatus('The file variant requires an absolute HTTPS URL.', 'error');
        patches.set(variant, { files: [{ uri: state.context.fileUrl.trim() }] });
      } else if (variant === 'agent') {
        if (!state.context.agentId.trim()) return setStatus('The agent variant requires an agent ID.', 'error');
        patches.set(variant, { agentId: state.context.agentId.trim() });
      } else if (variant === 'location') {
        if (protocol !== 'rest') return setStatus('Geographic location context is documented only for REST.', 'error');
        const latitudeText = state.context.latitude.trim();
        const longitudeText = state.context.longitude.trim();
        const countryOrRegion = state.context.countryOrRegion.trim().toUpperCase();
        if (Boolean(latitudeText) !== Boolean(longitudeText)) {
          return setStatus('Provide both latitude and longitude for the location variant.', 'error');
        }
        if (!latitudeText && !countryOrRegion) {
          return setStatus('Provide latitude/longitude or a two-letter country code for the location variant.', 'error');
        }
        if (countryOrRegion && !/^[A-Z]{2}$/.test(countryOrRegion)) {
          return setStatus('Country or region must be a two-letter code, such as BE or US.', 'error');
        }
        if (state.context.countryOrRegionConfidence.trim() && !countryOrRegion) {
          return setStatus('A country code is required when country confidence is set.', 'error');
        }
        const location = {
          ...(latitudeText ? { latitude: Number(latitudeText), longitude: Number(longitudeText) } : {}),
          ...(countryOrRegion ? { countryOrRegion } : {}),
          ...(state.context.countryOrRegionConfidence.trim()
            ? { countryOrRegionConfidence: Number(state.context.countryOrRegionConfidence) }
            : {}),
        };
        if (
          (latitudeText && (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90)) ||
          (longitudeText && (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180))
        ) {
          return setStatus('Latitude must be -90 to 90 and longitude must be -180 to 180.', 'error');
        }
        if (
          location.countryOrRegionConfidence != null &&
          (!Number.isFinite(location.countryOrRegionConfidence) ||
            location.countryOrRegionConfidence < 0 ||
            location.countryOrRegionConfidence > 1)
        ) {
          return setStatus('Country confidence must be from 0 to 1.', 'error');
        }
        patches.set(variant, { location });
      } else if (variant === 'additional') {
        if (protocol !== 'rest') return setStatus('Additional text context is documented only for REST.', 'error');
        const text = state.context.additionalContextText.trim();
        if (!text) return setStatus('Enter text for the additional-context variant.', 'error');
        patches.set(variant, {
          additionalContext: [
            {
              text,
              ...(state.context.additionalContextDescription.trim()
                ? { description: state.context.additionalContextDescription.trim() }
                : {}),
            },
          ],
        });
      }
    }
    const targets = Array.from({ length: 2 ** variants.length }, (_, mask) => {
      const enabled = variants.filter((_, index) => mask & (1 << index));
      const labels = enabled.map((variant) => optionById.get(variant)?.label || variant);
      return {
        id: enabled.length ? enabled.join('-') : 'baseline',
        protocol,
        label: enabled.length ? labels.join(' + ') : 'Baseline · all selected settings off',
        summary: enabled.length ? `Enabled: ${labels.join(' + ')}` : 'Enabled: none of the selected settings',
        timeZone,
        ...(protocol === 'rest' ? { webEnabled: false } : {}),
        ...Object.assign({}, ...enabled.map((variant) => patches.get(variant))),
      };
    });
    executeRun({ kind: 'context', prompt, targets });
  }

  function capabilityCell(protocol, key, protocolName, responseEvidence) {
    const capabilities = protocol?.capabilities || protocol?.supported || protocol || {};
    const value = capabilities[key];
    const sharedEvidence =
      responseEvidence?.[protocolName]?.[key] ??
      responseEvidence?.[key]?.[protocolName] ??
      responseEvidence?.[`${protocolName}.${key}`] ??
      '';
    if (value == null) return { label: 'Unverified', className: 'warn', evidence: 'No runtime evidence returned' };
    if (typeof value === 'boolean') {
      return value
        ? { label: 'Supported', className: 'ok', evidence: protocol?.evidence?.[key] || sharedEvidence || 'Implemented by this lab' }
        : {
            label: 'Not exposed',
            className: 'bad',
            evidence: protocol?.evidence?.[key] || sharedEvidence || 'Not available on this protocol',
          };
    }
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return {
        label: value,
        className: /support|available|yes|wire/.test(lower) ? 'ok' : /conditional|partial|sdk|unverified/.test(lower) ? 'warn' : 'bad',
        evidence: protocol?.evidence?.[key] || sharedEvidence || '',
      };
    }
    const label = value.status || value.value || (value.supported === true ? 'Supported' : value.supported === false ? 'Not exposed' : 'Conditional');
    const lower = String(label).toLowerCase();
    return {
      label,
      className: /support|available|yes|wire/.test(lower) ? 'ok' : /conditional|partial|sdk|unverified/.test(lower) ? 'warn' : 'bad',
      evidence: value.evidence || value.source || value.detail || sharedEvidence || '',
    };
  }

  function renderCapabilities() {
    const data = state.capabilities;
    const protocols = data?.protocols || {};
    const mcpTools = window.WorkIqMcpTools.normalize(
      data?.runtime?.tools,
      data?.runtime?.toolNames
    );
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Runtime capabilities and MCP tools</h3><p>Inspect documented service behavior, runtime metadata, the current MCP tool surface, and what this lab implements. Refreshing metadata does not invoke a billable Work IQ tool.</p></div>
        <button id="refreshCapabilities" class="exp-button secondary" type="button">Refresh metadata</button>
      </div>
      ${
        state.capabilitiesError ? `<div class="exp-callout bad">${escapeHtml(state.capabilitiesError)}</div>` : ''
      }
      ${
        data
          ? `<article class="exp-card">
              <span class="eyebrow">Available MCP tools</span>
              <h4>${escapeHtml(`${mcpTools.length} tool${mcpTools.length === 1 ? '' : 's'} discovered`)}</h4>
              <p>Select a tool to inspect its live description and input parameters. Loading this schema-only <code>tools/list</code> surface does not call any tool or send a Work IQ ask.</p>
              ${
                data.runtime?.error
                  ? `<div class="exp-callout bad">${escapeHtml(data.runtime.error)}</div>`
                  : mcpTools.length
                    ? window.WorkIqMcpTools.render(mcpTools)
                    : '<div class="exp-empty">The active MCP server exposed no tools.</div>'
              }
            </article>
            <div class="exp-table-wrap"><table class="exp-table">
              <thead><tr><th>Capability</th>${PROTOCOLS.map((protocol) => `<th>${protocolLabel(protocol)}</th>`).join('')}</tr></thead>
              <tbody>${CAPABILITIES.map(
                ([key, label]) => `<tr><td><strong>${escapeHtml(label)}</strong></td>${PROTOCOLS.map((protocolName) => {
                  const cell = capabilityCell(protocols[protocolName], key, protocolName, data.evidence);
                  return `<td><span class="exp-badge ${cell.className}">${escapeHtml(cell.label)}</span>${
                    cell.evidence ? `<span class="exp-evidence">${escapeHtml(cell.evidence)}</span>` : ''
                  }</td>`;
                }).join('')}</tr>`
              ).join('')}</tbody>
            </table></div>
            <div class="exp-callout">Generated ${escapeHtml(data.generatedAt ? new Date(data.generatedAt).toLocaleString() : 'now')}. ${
              data.runtime?.error ? `Runtime metadata warning: ${escapeHtml(data.runtime.error)}` : 'Runtime metadata loaded.'
            }</div>`
          : '<div class="exp-empty">Loading protocol capabilities…</div>'
      }
    </section>`;
    $('refreshCapabilities')?.addEventListener('click', () => loadCapabilities(true));
  }

  async function loadCapabilities(force = false) {
    if (state.capabilities && !force) return;
    state.capabilitiesError = null;
    setStatus('Loading non-billable runtime metadata…', 'running');
    try {
      const response = await fetch('/api/lab/capabilities');
      const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      state.capabilities = data;
      setStatus('Capability metadata loaded.');
    } catch (error) {
      state.capabilitiesError = error.message;
      setStatus(error.message, 'error');
    }
    if (state.activeTab === 'capabilities') renderCapabilities();
  }

  function allTargets() {
    return state.runs.flatMap((run) => Object.values(run.targets));
  }

  function numberAverage(values) {
    const valid = values.filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
    return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
  }

  function renderMetrics() {
    const targets = allTargets();
    const completed = targets.filter((target) => target.status === 'complete');
    const failed = targets.filter((target) => target.status === 'error');
    const eventCount = completed.reduce(
      (total, target) => total + Number(resultMetrics(target).eventCount || target.events.length || 0),
      0
    );
    const sourceCount = completed.reduce(
      (total, target) => total + Number(resultMetrics(target).sourceCount || target.result?.sources?.length || 0),
      0
    );
    const protocolRows = PROTOCOLS.map((protocol) => {
      const protocolTargets = completed.filter((target) => target.protocol === protocol);
      const timingValues = (key) =>
        protocolTargets.map((target) => resultMetrics(target).timings?.[key]);
      return {
        protocol,
        count: protocolTargets.length,
        preparationMs: numberAverage(timingValues('preparationMs')),
        promptToFirstResponseMs: numberAverage(timingValues('promptToFirstResponseMs')),
        promptToCompleteMs: numberAverage(timingValues('promptToCompleteMs')),
        totalMs: numberAverage(timingValues('totalMs')),
      };
    }).filter((row) => row.count);
    panel.innerHTML = `<section class="exp-section">
      <div class="exp-section-head">
        <div><h3>Performance dashboard</h3><p>Protocol-specific lifecycle timing for experiment calls captured in this browser tab. No blended cross-protocol latency score is shown.</p></div>
      </div>
      <div class="exp-dashboard">
        <article class="exp-dashboard-card"><span>Experiment calls</span><strong>${targets.length}</strong><small>Exact · this browser tab</small></article>
        <article class="exp-dashboard-card"><span>Successful calls</span><strong>${completed.length}</strong><small>${failed.length} failed or partial</small></article>
        <article class="exp-dashboard-card"><span>Captured events</span><strong>${eventCount}</strong><small>Diagnostics only; event units differ by protocol</small></article>
        <article class="exp-dashboard-card"><span>Structured sources</span><strong>${sourceCount}</strong><small>Diagnostics only; MCP ask does not expose them</small></article>
      </div>
      ${
        protocolRows.length
          ? `<div class="exp-table-wrap"><table class="exp-table"><thead><tr><th>Protocol</th><th>Calls</th><th>Avg preparation</th><th>Avg prompt → first observed</th><th>Avg prompt → complete</th><th>Avg end-to-end</th></tr></thead><tbody>${protocolRows
              .map(
                (row) =>
                  `<tr><td><strong>${protocolLabel(row.protocol)}</strong></td><td>${row.count}</td><td>${formatMs(
                    row.preparationMs
                  )}</td><td>${formatMs(row.promptToFirstResponseMs)}</td><td>${formatMs(
                    row.promptToCompleteMs
                  )}</td><td>${formatMs(row.totalMs)}</td></tr>`
              )
              .join('')}</tbody></table></div>`
          : '<div class="exp-empty">Run an experiment to populate protocol timing.</div>'
      }
      <div class="exp-callout warn"><strong>Read timing by response mode</strong><br>For streaming calls, “first observed” is the first response header or stream event and delivery is measured separately. For terminal REST/A2A and MCP, “first observed” is the complete response available to this app, so it is expected to be close to prompt-to-complete.</div>
    </section>`;
  }

  function renderActiveTab() {
    const renderers = {
      compare: renderCompare,
      inspector: renderInspector,
      cards: renderCards,
      context: renderContext,
      capabilities: renderCapabilities,
      metrics: renderMetrics,
    };
    renderers[state.activeTab]?.();
  }

  document.querySelectorAll('.workspace-tab').forEach((button) => {
    button.addEventListener('click', () => {
      const experiments = button.dataset.workspace === 'experiments';
      document.querySelectorAll('.workspace-tab').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
      $('liveView').classList.toggle('hidden', experiments);
      $('experimentView').classList.toggle('hidden', !experiments);
      if (experiments) {
        renderActiveTab();
        loadAvailableAgents();
      }
    });
  });

  document.querySelectorAll('.experiment-tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.experiment;
      document.querySelectorAll('.experiment-tab').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-selected', String(active));
        candidate.tabIndex = active ? 0 : -1;
      });
      if (state.activeTab === 'capabilities') loadCapabilities();
      renderActiveTab();
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('.experiment-tab')];
      const current = tabs.indexOf(button);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });
  });

  window.addEventListener('workiq:agents', (event) => {
    syncAvailableAgents(event.detail?.agents);
    state.agentsError = event.detail?.error || '';
    if (state.activeTab === 'cards') renderCards();
  });
  window.addEventListener('workiq:new-chat', () => {
    setStatus('Conversation state cleared. Existing experiment runs remain isolated in this tab.');
  });

  renderActiveTab();
})();
