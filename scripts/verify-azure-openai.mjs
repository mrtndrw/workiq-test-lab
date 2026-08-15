import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { parse } from 'dotenv';
import { AzureOpenAI } from 'openai';

const args = process.argv.slice(2);
let envPath = '.env';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--env' && args[index + 1]) {
    envPath = args[index + 1];
    index += 1;
  } else {
    console.error('Usage: node scripts/verify-azure-openai.mjs [--env <path>]');
    process.exit(2);
  }
}

const resolvedPath = path.resolve(envPath);
let fileConfig;
try {
  fileConfig = parse(readFileSync(resolvedPath));
} catch (error) {
  console.error(`Azure OpenAI verification failed: ${error.message}`);
  process.exit(1);
}
for (const [name, value] of Object.entries(fileConfig)) {
  if (process.env[name] === undefined) process.env[name] = value;
}

const endpoint = fileConfig.AZURE_OPENAI_ENDPOINT?.trim();
const defaultDeployment = fileConfig.AZURE_OPENAI_DEPLOYMENT?.trim();
const apiVersion = fileConfig.AZURE_OPENAI_API_VERSION?.trim();
const deployments = [
  ...new Set(
    [defaultDeployment, ...(fileConfig.AZURE_OPENAI_DEPLOYMENTS || '').split(',')]
      .map((value) => value?.trim())
      .filter(Boolean)
  ),
];

if (!endpoint || !defaultDeployment || !apiVersion) {
  console.error(
    'Azure OpenAI verification failed: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, and AZURE_OPENAI_API_VERSION are required.'
  );
  process.exit(1);
}

const credential = new DefaultAzureCredential();
const scope = 'https://cognitiveservices.azure.com/.default';
const tokenProvider = getBearerTokenProvider(credential, scope);
const client = new AzureOpenAI({
  endpoint,
  apiVersion,
  azureADTokenProvider: tokenProvider,
  maxRetries: 0,
  timeout: 30_000,
});

try {
  await credential.getToken(scope);
  console.log('Azure credential acquired. Testing configured deployment tool calling...');

  for (const deployment of deployments) {
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        {
          role: 'user',
          content: 'Call the readiness_check function once with status set to ready.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'readiness_check',
            description: 'Confirms that this deployment supports tool calling.',
            parameters: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['ready'] },
              },
              required: ['status'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'readiness_check' } },
      max_completion_tokens: 64,
    });
    const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.name !== 'readiness_check') {
      throw new Error(`Deployment "${deployment}" returned no readiness_check tool call.`);
    }
    console.log(`- ${deployment}: ready`);
  }
} catch (error) {
  const status = error?.status ? ` (HTTP ${error.status})` : '';
  const code = error?.code ? ` [${error.code}]` : '';
  console.error(`Azure OpenAI verification failed${status}${code}: ${error.message}`);
  process.exit(1);
}
