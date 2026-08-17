import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, experimentsSource, indexSource, serverSource] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/experiments.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
]);

test('live rail discovers and renders expandable MCP tool metadata when MCP is active', () => {
  assert.match(indexSource, /id="mcpToolSurface"/);
  assert.match(appSource, /function routeUsesMcp\(\)/);
  assert.match(appSource, /fetch\('\/api\/lab\/capabilities'\)/);
  assert.match(appSource, /<details class="mcp-tool-details">/);
  assert.match(appSource, /tool\.description/);
  assert.match(appSource, /tool\.inputSchema\?\.properties/);
  assert.match(serverSource, /tools: mcpRuntime\.tools/);
});

test('Experiments reuses the expandable live MCP tool details', () => {
  assert.match(experimentsSource, /Runtime capabilities and MCP tools/);
  assert.match(experimentsSource, /Available MCP tools/);
  assert.match(experimentsSource, /window\.WorkIqMcpTools\.render\(mcpTools\)/);
});
