import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parse } from 'dotenv';

function usage() {
  console.error('Usage: node scripts/verify-config.mjs [--env <path>]');
}

let envPath = '.env';
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== '--env' || !process.argv[index + 1] || index + 2 !== process.argv.length) {
    usage();
    process.exit(2);
  }
  envPath = process.argv[index + 1];
  index += 1;
}

const resolvedPath = path.resolve(envPath);
const errors = [];
let config;
try {
  config = parse(readFileSync(resolvedPath));
  if (process.platform !== 'win32' && (statSync(resolvedPath).mode & 0o077) !== 0) {
    errors.push('The configuration file must be owner-only (chmod 600).');
  }
} catch (error) {
  console.error(`Configuration validation failed: ${error.message}`);
  process.exit(1);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const placeholderPattern = /(change[-_ ]?me|your[-_ <]|<[^>]+>|example|placeholder)/i;

function requireValue(name) {
  const value = config[name]?.trim();
  if (!value) errors.push(`${name} is required.`);
  return value || '';
}

const tenantId = requireValue('ENTRA_TENANT_ID');
const clientId = requireValue('ENTRA_CLIENT_ID');
const clientSecret = requireValue('ENTRA_CLIENT_SECRET');
const redirectUri = requireValue('REDIRECT_URI');
const sessionSecret = requireValue('SESSION_SECRET');
const portText = requireValue('PORT');

if (tenantId && !uuidPattern.test(tenantId)) {
  errors.push('ENTRA_TENANT_ID must be a tenant UUID, not common, organizations, or a domain name.');
}
if (clientId && !uuidPattern.test(clientId)) {
  errors.push('ENTRA_CLIENT_ID must be an application (client) UUID.');
}
if (clientSecret && (clientSecret.length < 16 || placeholderPattern.test(clientSecret))) {
  errors.push('ENTRA_CLIENT_SECRET must be the client secret value and must not be a placeholder.');
}
if (sessionSecret && (Buffer.byteLength(sessionSecret) < 32 || placeholderPattern.test(sessionSecret))) {
  errors.push('SESSION_SECRET must be a non-placeholder value of at least 32 bytes.');
}
if (sessionSecret && clientSecret && sessionSecret === clientSecret) {
  errors.push('SESSION_SECRET must be different from ENTRA_CLIENT_SECRET.');
}

const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  errors.push('PORT must be an integer from 1 through 65535.');
}

try {
  const url = new URL(redirectUri);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.username || url.password || url.search || url.hash) {
    errors.push('REDIRECT_URI must not contain credentials, a query string, or a fragment.');
  }
  if (url.pathname !== '/auth/callback') {
    errors.push('REDIRECT_URI must use the /auth/callback path expected by this application.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
    errors.push('REDIRECT_URI must use HTTPS, except that HTTP is allowed for a loopback host.');
  }
  const redirectPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (Number.isInteger(port) && loopbackHosts.has(url.hostname) && redirectPort !== port) {
    errors.push('PORT must match the explicit or default port in a loopback REDIRECT_URI.');
  }
} catch {
  errors.push('REDIRECT_URI must be an absolute URL.');
}

const mcpTransport = (config.WORKIQ_MCP_TRANSPORT || 'remote').trim().toLowerCase();
if (!['remote', 'local'].includes(mcpTransport)) {
  errors.push('WORKIQ_MCP_TRANSPORT must be remote or local.');
}

const mcpFallback = (config.WORKIQ_MCP_REMOTE_FALLBACK || 'off').trim().toLowerCase();
if (mcpFallback !== 'off') {
  errors.push('WORKIQ_MCP_REMOTE_FALLBACK must be off so a request can never switch identities.');
}
if (config.WORKIQ_MCP_PACKAGE) {
  errors.push('WORKIQ_MCP_PACKAGE is no longer supported; the CLI version is pinned in package-lock.json.');
}
if (
  config.WORKIQ_MCP_ACCEPT_EULA != null &&
  !['true', 'false'].includes(config.WORKIQ_MCP_ACCEPT_EULA.trim().toLowerCase())
) {
  errors.push('WORKIQ_MCP_ACCEPT_EULA must be true or false when provided.');
}
if (mcpTransport === 'local' && config.WORKIQ_MCP_ACCEPT_EULA?.trim().toLowerCase() !== 'true') {
  errors.push('Local MCP requires explicit WORKIQ_MCP_ACCEPT_EULA=true after the operator reviews the terms.');
}

const host = (config.HOST || '127.0.0.1').trim();
const loopbackListenHosts = new Set(['localhost', '127.0.0.1', '::1']);
const allowRemoteBind = (config.WORKIQ_ALLOW_REMOTE_BIND || 'false').trim().toLowerCase();
if (!['true', 'false'].includes(allowRemoteBind)) {
  errors.push('WORKIQ_ALLOW_REMOTE_BIND must be true or false when provided.');
}
if (!loopbackListenHosts.has(host) && allowRemoteBind !== 'true') {
  errors.push('A non-loopback HOST requires WORKIQ_ALLOW_REMOTE_BIND=true.');
}
if (mcpTransport === 'local' && !loopbackListenHosts.has(host)) {
  errors.push('Local MCP requires a loopback HOST because the CLI uses a separate cached identity.');
}

if (config.WORKIQ_MCP_URL) {
  try {
    const url = new URL(config.WORKIQ_MCP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) {
      errors.push('WORKIQ_MCP_URL must be an HTTPS URL without embedded credentials.');
    }
  } catch {
    errors.push('WORKIQ_MCP_URL must be an absolute HTTPS URL.');
  }
}

const azureFields = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'];
const configuredAzureFields = azureFields.filter((name) => config[name]?.trim());
const hasAzureConfig = configuredAzureFields.length > 0 || Boolean(config.AZURE_OPENAI_DEPLOYMENTS?.trim());
if (hasAzureConfig && configuredAzureFields.length !== azureFields.length) {
  errors.push(`${azureFields.join(', ')} must all be set when Azure OpenAI orchestration is configured.`);
}
if (config.AZURE_OPENAI_ENDPOINT) {
  try {
    const url = new URL(config.AZURE_OPENAI_ENDPOINT);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      errors.push('AZURE_OPENAI_ENDPOINT must be an HTTPS resource URL without credentials, query, or fragment.');
    }
  } catch {
    errors.push('AZURE_OPENAI_ENDPOINT must be an absolute HTTPS URL.');
  }
}
if (config.AZURE_OPENAI_DEPLOYMENTS) {
  const listedDeployments = config.AZURE_OPENAI_DEPLOYMENTS.split(',').map((value) => value.trim());
  if (listedDeployments.some((value) => !value)) {
    errors.push('AZURE_OPENAI_DEPLOYMENTS must be a comma-separated list without empty entries.');
  } else if (new Set(listedDeployments).size !== listedDeployments.length) {
    errors.push('AZURE_OPENAI_DEPLOYMENTS must not contain duplicate deployment names.');
  } else if (
    config.AZURE_OPENAI_DEPLOYMENT &&
    !listedDeployments.includes(config.AZURE_OPENAI_DEPLOYMENT.trim())
  ) {
    errors.push('AZURE_OPENAI_DEPLOYMENTS must include AZURE_OPENAI_DEPLOYMENT.');
  }
}
if (config.AZURE_TENANT_ID && !uuidPattern.test(config.AZURE_TENANT_ID.trim())) {
  errors.push('AZURE_TENANT_ID must be an Azure tenant UUID.');
}
if (config.AZURE_CLIENT_ID && !uuidPattern.test(config.AZURE_CLIENT_ID.trim())) {
  errors.push('AZURE_CLIENT_ID must be an application or managed-identity client UUID.');
}
if (config.AZURE_CLIENT_SECRET) {
  if (!config.AZURE_TENANT_ID?.trim() || !config.AZURE_CLIENT_ID?.trim()) {
    errors.push('AZURE_CLIENT_SECRET requires AZURE_TENANT_ID and AZURE_CLIENT_ID.');
  }
  if (config.AZURE_CLIENT_SECRET.length < 16 || placeholderPattern.test(config.AZURE_CLIENT_SECRET)) {
    errors.push('AZURE_CLIENT_SECRET must be a non-placeholder service-principal secret value.');
  }
  if (config.AZURE_CLIENT_SECRET === clientSecret) {
    errors.push('AZURE_CLIENT_SECRET must be different from ENTRA_CLIENT_SECRET.');
  }
}

if (errors.length > 0) {
  console.error(`Configuration validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Configuration is valid: ${resolvedPath}`);
