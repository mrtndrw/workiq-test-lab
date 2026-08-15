import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, experimentsSource, indexSource] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/experiments.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
]);

test('live rail discovers and renders MCP tools when MCP is active', () => {
  assert.match(indexSource, /id="mcpToolSurface"/);
  assert.match(appSource, /function routeUsesMcp\(\)/);
  assert.match(appSource, /fetch\('\/api\/lab\/capabilities'\)/);
  assert.match(appSource, /data\.runtime\.toolNames/);
});

test('Experiments renders the discovered MCP tool surface', () => {
  assert.match(experimentsSource, /Runtime capabilities and MCP tools/);
  assert.match(experimentsSource, /Available MCP tools/);
  assert.match(experimentsSource, /mcpToolNames\.join\('\\n'\)/);
});
