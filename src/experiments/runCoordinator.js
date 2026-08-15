// Experiment workbench run coordinator.
//
// Runs 1-8 direct Work IQ protocol targets (rest/a2a/mcp — never the composed
// llm agent) concurrently for a single prompt, and reports live progress plus
// a final summary via a callback. This is a pure orchestration layer: no
// retries, no persistence, and one target failing never cancels the others.
// An AbortSignal cancels every in-flight target at once.

import { Trace } from '../trace.js';
import * as restAdapter from '../adapters/restAdapter.js';
import * as a2aAdapter from '../adapters/a2aAdapter.js';
import * as mcpAdapter from '../adapters/mcpAdapter.js';

const DIRECT_ADAPTERS = { rest: restAdapter, a2a: a2aAdapter, mcp: mcpAdapter };
const INBOUND_SINK_KINDS = new Set(['response', 'response_headers', 'data', 'sdk_response', 'sdk_error']);
const OUTBOUND_SINK_KINDS = new Set(['request', 'sdk_request']);

class EventConsumerError extends Error {
  constructor(cause) {
    super(`Experiment event consumer failed: ${cause?.message || String(cause)}`, { cause });
    this.name = 'EventConsumerError';
  }
}

function emitEvent(onEvent, type, data) {
  if (!onEvent) return;
  try {
    onEvent(type, data);
  } catch (error) {
    throw new EventConsumerError(error);
  }
}

function extractTimeZone(sinkEvent) {
  const data = sinkEvent?.data;
  return (
    data?.body?.locationHint?.timeZone ||
    data?.body?.params?.message?.metadata?.Location?.timeZone ||
    data?.arguments?.timeZone ||
    null
  );
}

function waitForAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Run a single target to completion, reporting target_start / protocol_event /
 * target_result|target_error through `emit`. Never throws — failures resolve
 * with a settled result object so one target can't cancel its siblings.
 */
async function runTarget({
  target,
  prompt,
  token,
  signal,
  emit,
  streamResponses,
  dispatchBarrier,
  markReady,
  prepareBeforeDispatch,
  runStartedAt,
}) {
  const { id, protocol, conversationId, agentId, files, webEnabled, timeZone, location, additionalContext } = target;
  const adapter = DIRECT_ADAPTERS[protocol];
  const startedAt = Date.now();
  let ttfbMs = null;
  let eventCount = 0;
  let preparationMs = 0;
  let promptDispatchMs = null;
  let wireDispatchMs = null;
  let operation = null;
  let appliedTimeZone = null;
  let prepared = null;
  let ready = false;

  // Trace sink events include the outbound 'request' event (fired the instant
  // the call is issued, before any response arrives) alongside inbound events
  // ('response', 'response_headers', parsed SSE 'data', 'complete'). TTFB must
  // reflect time-to-first-response, so only inbound kinds may set ttfbMs.
  const markEvent = (isInbound, atMs = Date.now() - startedAt) => {
    eventCount += 1;
    if (isInbound && ttfbMs === null) ttfbMs = atMs;
  };
  const signalReady = () => {
    if (ready) return;
    ready = true;
    markReady();
  };

  const trace = new Trace({
    onEvent: (sinkEvent) => {
      const isAnswerEvent = protocol !== 'rest' || sinkEvent?.title !== 'Create conversation';
      if (
        promptDispatchMs !== null &&
        isAnswerEvent &&
        OUTBOUND_SINK_KINDS.has(sinkEvent?.kind) &&
        wireDispatchMs === null
      ) {
        wireDispatchMs = sinkEvent.ts;
        operation = sinkEvent.title || null;
        appliedTimeZone = extractTimeZone(sinkEvent);
      }
      markEvent(
        promptDispatchMs !== null && isAnswerEvent && INBOUND_SINK_KINDS.has(sinkEvent?.kind),
        sinkEvent?.ts
      );
      emitEvent(emit, 'protocol_event', { targetId: id, protocol, event: sinkEvent });
    },
  });

  try {
    emitEvent(emit, 'target_start', { targetId: id, protocol, startedAt });
    if (!adapter) throw new Error(`Unsupported experiment target protocol: ${protocol}`);

    const askArgs = {
      question: prompt,
      token,
      conversationId,
      agentId,
      files,
      webEnabled,
      timeZone,
      location,
      additionalContext,
      trace,
      signal,
    };

    if (prepareBeforeDispatch && typeof adapter.prepareAsk === 'function') {
      prepared = await adapter.prepareAsk(askArgs);
    }
    preparationMs = Date.now() - startedAt;
    signalReady();
    await dispatchBarrier;
    promptDispatchMs = Date.now() - startedAt;

    // MCP has no streaming ask. REST/A2A stream by default, but comparisons can
    // use their terminal endpoints when the user disables response streaming.
    const streamEvents = {
      onEvent: (evt) => {
        // Every adapter-level stream event (delta/status/tool-result/etc.) is
        // inbound by construction — it was parsed from the response.
        markEvent(true);
        emitEvent(emit, 'protocol_event', {
          targetId: id,
          protocol,
          event: { kind: evt?.type || 'stream', title: 'Stream event', layer: 'sse', data: evt },
        });
        if (evt?.type === 'delta' && typeof evt.text === 'string') {
          emitEvent(emit, 'target_delta', {
            targetId: id,
            protocol,
            text: evt.text,
            replace: evt.replace === true,
          });
        }
      },
    };
    const responseMode = protocol !== 'mcp' && streamResponses ? 'streaming' : 'terminal';
    const result =
      responseMode === 'streaming'
        ? prepared?.askStream
          ? await prepared.askStream(streamEvents)
          : await adapter.askStream({ ...askArgs, ...streamEvents })
        : prepared?.ask
          ? await prepared.ask()
          : await adapter.ask(askArgs);

    const totalMs = Date.now() - startedAt;
    const firstResponseMs = ttfbMs === null ? totalMs : ttfbMs;
    const dispatchMs = promptDispatchMs ?? preparationMs;
    const answer = typeof result.answer === 'string' ? result.answer : '';
    const sources = Array.isArray(result.sources) ? result.sources : [];
    const targetResult = {
      targetId: id,
      protocol,
      totalMs,
      ttfbMs: firstResponseMs,
      eventCount,
      answerChars: answer.length,
      sourceCount: sources.length,
      responseMode,
      operation,
      context: {
        requestedTimeZone: timeZone || null,
        appliedTimeZone,
      },
      timings: {
        preparationMs,
        barrierWaitMs: Math.max(0, dispatchMs - preparationMs),
        dispatchOffsetMs: Math.max(0, startedAt + dispatchMs - runStartedAt),
        wireDispatchOffsetMs:
          wireDispatchMs === null ? null : Math.max(0, startedAt + wireDispatchMs - runStartedAt),
        wireDispatchDelayMs: wireDispatchMs === null ? null : Math.max(0, wireDispatchMs - dispatchMs),
        promptToFirstResponseMs: Math.max(0, firstResponseMs - dispatchMs),
        responseDeliveryMs:
          responseMode === 'streaming' ? Math.max(0, totalMs - firstResponseMs) : null,
        promptToCompleteMs: Math.max(0, totalMs - dispatchMs),
        totalMs,
      },
      answer,
      sources,
      sourcesStatus: result.sourcesStatus ?? 'available',
      sourceNote: result.sourceNote ?? null,
      conversationId: result.conversationId ?? null,
      taskId: result.taskId ?? null,
      taskState: result.taskState ?? null,
    };
    emitEvent(emit, 'target_result', targetResult);
    return { status: 'fulfilled', targetId: id, protocol, result: targetResult };
  } catch (e) {
    if (e instanceof EventConsumerError) throw e;
    const totalMs = Date.now() - startedAt;
    const dispatchMs = promptDispatchMs ?? preparationMs;
    const errorResult = {
      targetId: id,
      protocol,
      totalMs,
      eventCount,
      timings: {
        preparationMs,
        barrierWaitMs: promptDispatchMs === null ? null : Math.max(0, dispatchMs - preparationMs),
        dispatchOffsetMs:
          promptDispatchMs === null ? null : Math.max(0, startedAt + dispatchMs - runStartedAt),
        wireDispatchOffsetMs:
          wireDispatchMs === null ? null : Math.max(0, startedAt + wireDispatchMs - runStartedAt),
        wireDispatchDelayMs: wireDispatchMs === null ? null : Math.max(0, wireDispatchMs - dispatchMs),
        totalMs,
      },
      error: e?.userMessage || e?.message || 'Unknown error',
      needsLogin: Boolean(e?.needsLogin),
      aborted: Boolean(signal?.aborted),
    };
    emitEvent(emit, 'target_error', errorResult);
    return { status: 'rejected', targetId: id, protocol, error: errorResult };
  } finally {
    signalReady();
    await prepared?.cleanup?.();
  }
}

/**
 * @param {{
 *   kind: 'inspect'|'comparison'|'context',
 *   prompt: string,
 *   targets: Array<{id:string, protocol:'rest'|'a2a'|'mcp', conversationId?:string, agentId?:string, files?:Array, webEnabled?:boolean, timeZone?:string, location?:object, additionalContext?:Array}>,
 *   token?: string,
 *   streamResponses?: boolean,
 *   signal?: AbortSignal,
 *   onEvent?: (type:string, data:object) => void,
 * }} opts
 * @returns {Promise<object>} the terminal run_result payload (also delivered via onEvent).
 */
export async function runCoordinator({
  kind,
  prompt,
  targets,
  token,
  streamResponses = true,
  signal,
  onEvent,
}) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) {
    throw new Error('targets must contain between 1 and 8 entries.');
  }

  const runStarted = Date.now();
  const settled = [];
  const batchSize = kind === 'context' ? 2 : 4;
  for (let index = 0; index < targets.length; index += batchSize) {
    const batchTargets = targets.slice(index, index + batchSize);
    let releaseDispatch;
    const dispatchBarrier = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    const readyResolvers = [];
    const allReady = Promise.all(
      batchTargets.map(
        () =>
          new Promise((resolve) => {
           readyResolvers.push(resolve);
          })
      )
    );
    const batchRuns = batchTargets.map((target, batchIndex) =>
      runTarget({
        target,
        prompt,
        token,
        signal,
        emit: onEvent,
        streamResponses,
        dispatchBarrier,
        markReady: readyResolvers[batchIndex],
        prepareBeforeDispatch: kind === 'comparison',
        runStartedAt: runStarted,
      })
    );
    const settledBatch = Promise.allSettled(batchRuns);
    try {
      await waitForAbort(allReady, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      releaseDispatch();
    }
    settled.push(...(await settledBatch));
  }
  const consumerFailure = settled.find(
    (entry) => entry.status === 'rejected' && entry.reason instanceof EventConsumerError
  );
  if (consumerFailure) throw consumerFailure.reason;

  // runTarget never rejects (it settles its own errors internally), but guard
  // defensively in case a future change introduces an uncaught throw.
  const outcomes = settled.map((entry, index) =>
    entry.status === 'fulfilled'
      ? entry.value
      : {
          status: 'rejected',
          targetId: targets[index]?.id,
          protocol: targets[index]?.protocol,
          error: { error: entry.reason?.message || 'Unknown error' },
        }
  );

  const runResult = {
    kind,
    totalMs: Date.now() - runStarted,
    aborted: Boolean(signal?.aborted),
    succeeded: outcomes.filter((o) => o.status === 'fulfilled').length,
    failed: outcomes.filter((o) => o.status === 'rejected').length,
    targets: outcomes.map((o) => (o.status === 'fulfilled' ? o.result : o.error)),
  };
  const wireDispatchOffsets = runResult.targets
    .map((target) => target.timings?.wireDispatchOffsetMs)
    .filter((value) => Number.isFinite(value));
  const applicationDispatchOffsets = runResult.targets
    .map((target) => target.timings?.dispatchOffsetMs)
    .filter((value) => Number.isFinite(value));
  const dispatchOffsets =
    wireDispatchOffsets.length === runResult.targets.length ? wireDispatchOffsets : applicationDispatchOffsets;
  runResult.dispatchSkewMs =
    dispatchOffsets.length === runResult.targets.length
      ? Math.max(...dispatchOffsets) - Math.min(...dispatchOffsets)
      : null;
  emitEvent(onEvent, 'run_result', runResult);
  return runResult;
}
