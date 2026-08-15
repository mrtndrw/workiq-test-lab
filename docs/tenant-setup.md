# Set up the Work IQ Test Lab

This guide prepares a new Microsoft 365 tenant and a computer that will run the
Work IQ Test Lab. It was verified against the official Microsoft sources listed
at the end of this document on **August 15, 2026**.

The lab uses delegated access. It can access only data available to the signed-in
user, subject to existing Microsoft 365 permissions, labels, compliance
controls, and Work IQ tenant policy. Work IQ application-only access is not
supported.

This release supports users in the same tenant as its single-tenant app
registration. Microsoft parent/child or other cross-tenant organizations require
a multitenant registration and home-tenant authority, which this release does
not implement.

## Choose a setup path

| Path | Use when | Privilege profile |
| --- | --- | --- |
| [Manual setup](#manual-setup-recommended) | The customer requires strict least privilege and separation of duties | Recommended. Each administrator performs only their task. |
| [Scripted setup](#scripted-setup) | The customer accepts one short, reviewed automation session | Requires temporary Global Administrator because Azure CLI's admin-consent command requires it. |

Both paths create a dedicated single-tenant web app, grant only delegated
`WorkIQAgent.Ask`, require enterprise-app assignment, and restrict sign-in to an
approved security group (or approved individual users when group assignment is
unavailable). Neither path changes MCP mutation policy, which is configured
separately in the Microsoft 365 admin center under **Agents** > **Tools** >
**Work IQ MCP** > **Policies**.

## Prerequisites

- A Microsoft 365 work or school tenant.
- An approved Azure subscription and resource group for usage-based billing or pre-paid credits. Work IQ API is strictly usage-based billing, so cannot be used without billing policies configured.
- A security-enabled Entra group containing only the lab users. The script
  requires one; the manual path can assign approved users individually when
  group assignment is unavailable.
- A lab user with representative Microsoft 365 data and ordinary permissions.
- A downloaded or cloned copy of this release.
- Node.js 20 or later on the lab computer.
- OpenSSL.
- Azure CLI only when using the script.
- For remote MCP testing only: a tenant where the remote Work IQ MCP endpoint is
  available and tenant policy permits the intended tools. REST and A2A do not
  require remote MCP.
- Temporary eligible administrators listed below, preferably activated through
  Privileged Identity Management.

A Microsoft 365 Copilot add-on license is not the documented Work IQ API
entitlement. Direct Work IQ API usage is billed through Copilot Credits and the
lab users must be covered by a spending policy.

## Minimum administrator roles

You do not need Global administrator permissions for the entire setup.
Also see Microsoft documentation: https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq#prerequisites


| Task | Minimum verified role |
| --- | --- |
| Select or change the billing method | **Billing Administrator** |
| Create spending policies, limits, alerts, and reports | **AI Administrator** or **License Administrator** |
| Create the first-party Work IQ service principal, only if absent. See link to Microsoft docs above. | Temporary **Global Administrator** |
| Create an app when normal users cannot register apps | **Application Developer** |
| Manage the dedicated app registration | An app owner; otherwise **Cloud Application Administrator** or **Application Administrator** |
| Assign the approved group to the enterprise app | A service-principal owner; otherwise **Cloud Application Administrator**, **Application Administrator**, or **User Administrator** |
| Grant tenant-wide consent for delegated Work IQ access | A constrained custom directory role with the required consent permission; otherwise **Cloud Application Administrator**, **Application Administrator**, or **AI Administrator** |
| Run the automated `--apply` path | Temporary **Global Administrator**, because Azure CLI `admin-consent` requires it |
| Run the application | No administrator role |

If tenant policy allows normal members to register applications, a member can
create and own the app, add its requested permission, and create its credential.
The enterprise-app assignment and admin-consent steps still require the roles in
the table.

The first-party Work IQ service principal is a one-time tenant prerequisite.
Microsoft explicitly documents Global Administrator for that activation. 

## Record these values first

Use a customer-approved change record. Record:

- Tenant display name and tenant ID.
- Billing subscription, resource group, owner, limits, and alert recipients.
- Lab security-group display name and object ID.
- App display name, such as `Work IQ Test Lab`.
- Redirect URI. Local default:
  `http://localhost:3000/auth/callback`.
- Credential owner and rotation/removal date.

## Manual setup (recommended)

### 1. Configure Work IQ billing

As **Billing Administrator**:

1. Open [Microsoft 365 admin center](https://admin.microsoft.com) and go to
   **Copilot** > **Cost Management**.
2. In a new tenant, select **Get Started**. Choose the approved billing method
   and Azure subscription.
3. Set organization and per-user limits plus alert recipients.
4. Select **Customize setup configuration** before activation. Scope the policy
   to the approved lab group and select **Work IQ API** under **Select agents and
   services**.
5. Select **Activate**, then **Manage Configuration**.

If usage-based billing is already active, an **AI Administrator** or **License
Administrator** can open **Configuration** > **Add spending policy**, scope it to
the approved lab group, select **Work IQ API**, and set limits and alerts. A
**Billing Administrator** is needed only to select or change its billing method.

Verify the billing subscription, policy scope, **Work IQ API** service selection,
limits, alerts, and lab group. Cost reports are delayed aggregate data.

### 2. Verify or enable Work IQ

First check whether the first-party service principal already exists:

```bash
az login --tenant <tenant-id> --allow-no-subscriptions
az ad sp show --id fdcc1f02-fc51-4226-8753-f668596af7f7
```

If it exists, do not recreate it and do not activate Global Administrator. 

If it is absent, a **Global Administrator** should run (Also see Microsoft docs linked above.):

```bash
az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7
```

Verify exactly one enterprise application exists with that application ID.

### 3. Register the web application

As the app creator, **Application Developer**, **Cloud Application
Administrator**, or **Application Administrator**:

1. Open **Microsoft Entra admin center** > **Identity** > **Applications** >
   **App registrations** > **New registration**.
2. Enter the approved app name.
3. Select **Accounts in this organizational directory only**.
4. Choose the **Web** platform and enter the exact redirect URI (**http://localhost:3000/auth/callback**).
5. Record the Directory (tenant) ID and Application (client) ID.
6. In **Authentication**, verify:
   - Only the required Web redirect URI is present.
   - Implicit access-token and ID-token issuance are disabled.
   - Public client flows are disabled.

### 4. Add only Work IQ delegated access

In the new app registration:

1. Open **API permissions** > **Add a permission**.
2. Choose **APIs my organization uses** > **Work IQ**.
3. Select **Delegated permissions**.
4. Select only `WorkIQAgent.Ask`.
5. Save without adding Microsoft Graph or any other API permission. 

Verify:

- Resource application ID:
  `fdcc1f02-fc51-4226-8753-f668596af7f7`.
- Scope ID: `0b1715fd-f4bf-4c63-b16d-5be31f9847c2`.
- Permission type: **Delegated**.

### 5. Restrict who can sign in

As a service-principal owner, **Cloud Application Administrator**, **Application
Administrator**, or **User Administrator**:

1. Open **Enterprise applications** and select the new lab app.
2. Open **Properties**.
3. Set **Assignment required?** to **Yes**.
4. Open **Users and groups** and assign only the approved lab group.

Group assignment can require Entra ID P1. Without it, keep assignment required
and assign approved users individually. Nested groups are not expanded for
enterprise-app assignment.

Verify that an assigned user can reach sign-in and an unassigned user is denied.

### 6. Grant admin consent

As **Cloud Application Administrator**, **Application Administrator**, or
**AI Administrator**:

1. Return to the app's **API permissions**.
2. Confirm `WorkIQAgent.Ask` is the only requested permission.
3. Select **Grant admin consent**.
4. Confirm the customer tenant.

Verify the status is **Granted for** the intended tenant.

### 7. Create the server credential

The current application uses a client secret.

1. Open **Certificates & secrets** > **Client secrets**.
2. Create the shortest lifetime allowed by customer policy.
3. Copy the secret **value** immediately. The secret ID will not work.
4. Record a credential owner and rotation date.
5. Never put the value in source control, tickets, prompts, chat, or logs.

### 8. Create owner-only local configuration

Download or clone this release, then change to its repository root (the folder
containing `package.json`). Run:

```bash
npm ci
umask 077
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Replace every placeholder in `.env`:

```dotenv
ENTRA_TENANT_ID=<directory-tenant-id>
ENTRA_CLIENT_ID=<application-client-id>
ENTRA_CLIENT_SECRET=<client-secret-value>
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=<output-from-openssl>
PORT=3000
HOST=127.0.0.1
WORKIQ_MCP_TRANSPORT=remote
WORKIQ_MCP_REMOTE_FALLBACK=off
```

Validate without printing secret values:

```bash
npm run config:verify
```

### 9. Start and verify

```bash
npm start
```

Open the exact origin in `REDIRECT_URI`, normally
`http://localhost:3000`.

1. Sign in as an assigned lab user.
2. Confirm the consent screen names the customer app and delegated Work IQ.
3. Run a read-only direct REST prompt.
4. Run a read-only direct A2A prompt.
5. Test remote MCP only if the tenant exposes the endpoint.
6. Confirm sources and execution traces contain no bearer token or client secret.
7. Sign out and confirm the app returns to the sign-in-required state.

Billing and entitlement changes can take 15 to 30 minutes to propagate.

## Scripted setup

### What the script changes

`scripts/setup-tenant.sh`:

- Performs a read-only preflight by default.
- Pins the expected tenant ID and requires the same ID a second time for writes.
- Requires a validated security-enabled access group.
- Refuses service-principal identities and unsafe redirect URIs.
- Refuses to overwrite output or modify an existing app.
- Creates a new single-tenant app and client service principal.
- Adds only delegated `WorkIQAgent.Ask`.
- Requires enterprise-app assignment and assigns only the approved group.
- Grants and verifies tenant-wide consent.
- Creates a one-year client secret.
- Writes an owner-only, validated environment file without printing secrets.

It does not configure billing, spending policies, Azure OpenAI, or MCP mutation
policy.

### Privilege warning

The Azure CLI command used for admin consent requires **Global Administrator**.
The script therefore requires `--acknowledge-global-admin` with `--apply`.
Activate the role only for the reviewed apply run and deactivate it immediately
after verification.

Use the manual path when the customer requires lower-role consent or separation
of duties.

### 1. Install and sign in

Install current Azure CLI, Node.js 20 or later, and OpenSSL. From the repository
root, install the lockfile-pinned dependencies before any tenant write:

```bash
npm ci
az login --tenant <tenant-id> --allow-no-subscriptions
az account show --query '{tenantId:tenantId,user:user.name}' -o json
```

Confirm the displayed tenant before continuing.

### 2. Run the read-only preflight

```bash
./scripts/setup-tenant.sh \
  --tenant-id <tenant-id> \
  --access-group-id <security-group-object-id> \
  --app-name "Work IQ Test Lab"
```

No tenant writes occur without `--apply`. Review the tenant, app name, redirect
URI, access group, and Work IQ service-principal state.

### 3. Apply after approval

Activate temporary Global Administrator, then run:

```bash
./scripts/setup-tenant.sh \
  --tenant-id <tenant-id> \
  --confirm-tenant <tenant-id> \
  --access-group-id <security-group-object-id> \
  --app-name "Work IQ Test Lab" \
  --output-env .env.generated \
  --acknowledge-global-admin \
  --apply
```

The script never deletes a partially created app. If it stops after creating the
client secret, it preserves the secret in the owner-only output file and reports
that path. Review the reported application ID and output file before retrying.

### 4. Verify and start

```bash
npm run config:verify -- --env .env.generated
install -m 600 .env.generated .env
rm .env.generated
npm run config:verify
npm start
```

Deactivate Global Administrator after the tenant and app checks pass.

The script uses a one-year client-secret lifetime. Use the manual path instead
when customer policy requires a shorter lifetime.

## Optional remote MCP

Remote MCP is not required for direct REST or A2A testing. If the tenant exposes
the remote endpoint, the app reuses the signed-in user's delegated
`WorkIQAgent.Ask` token.

Before enabling the governed-action story, an authorized Microsoft 365
administrator should review **Agents** > **Tools** > **Work IQ MCP** >
**Policies** and allow only the required paths and methods. The delegated scope
can cover read and write operations, but the signed-in user's permissions,
labels, compliance controls, and Work IQ tenant policy still apply. See the
[Work IQ MCP overview](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/overview).

## Optional Azure OpenAI orchestration

Azure OpenAI is required only for **Agent orchestrated** mode. Direct REST, A2A,
and MCP testing works without it. Guided stories 02 and 03 use direct protocols;
stories 01 and 04 are agent-orchestrated and remain disabled until Azure OpenAI
is configured. When Azure OpenAI is absent, the app opens in **Direct protocol**
mode.

### 1. Create or select an Azure OpenAI resource

An Azure administrator can use an approved existing resource or
[create an Azure OpenAI resource](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource?pivots=web-portal).
The resource's network configuration must allow the computer or hosted service
running this application to reach its endpoint. If public network access is
disabled, configure private connectivity and DNS before testing the application.

### 2. Deploy one or more models

In [Microsoft Foundry](https://ai.azure.com/):

1. Open the Azure OpenAI resource.
2. Open **Deployments** or **Models + endpoints**.
3. Select **Deploy model** > **Deploy base model**.
4. Choose an approved chat-completions model that supports function/tool calling
   and is available in the resource's region.
5. Enter a clear deployment name, such as `workiq-orchestrator`.
6. Select the deployment type and capacity approved by the customer.
7. Deploy it and wait until its provisioning state is **Succeeded**.

One deployment is sufficient. Additional deployments are optional and populate
the application's model picker. All configured deployments must exist on the
same Azure OpenAI resource.

Azure OpenAI calls use the **deployment name**, not the underlying model name.
For example, a `gpt-4o` model deployed as `workiq-orchestrator` must be configured
as `workiq-orchestrator`.

Creating or changing deployments requires a provisioning role such as
**Cognitive Services OpenAI Contributor** on an existing resource. The
application runtime does not need that role.

### 3. Grant the runtime identity access

Grant **Cognitive Services OpenAI User** on the individual Azure OpenAI resource
to the identity that runs Node. This is the minimum built-in role that can make
inference API calls with Microsoft Entra ID.

Choose one runtime identity option.

#### Local option A: the operator's Azure CLI identity

Assign **Cognitive Services OpenAI User** to the user shown by:

```bash
az login --tenant <azure-resource-tenant-id>
az account show --query '{tenantId:tenantId,user:user.name}' -o json
```

This is the simplest option for one administrator or developer. It does not
require Global Administrator, but that person has personal inference access to
the Azure OpenAI resource.

#### Local option B: a dedicated service principal

Use this option when the local operator must not receive personal Azure OpenAI
access:

1. Create a separate, single-tenant app registration named, for example,
   `Work IQ Test Lab - Azure OpenAI runtime`.
2. Do not add Work IQ or Microsoft Graph API permissions. This identity uses
   Azure RBAC, not delegated API permissions.
3. Create a short-lived client secret and record its rotation owner and expiry.
4. On the Azure OpenAI resource, open **Access control (IAM)** and assign
   **Cognitive Services OpenAI User** to the new enterprise application.
5. Scope the assignment to this Azure OpenAI resource, not the subscription or
   resource group.
6. Add these separate runtime credentials to the owner-only `.env` file:

   ```dotenv
   AZURE_TENANT_ID=<azure-resource-tenant-id>
   AZURE_CLIENT_ID=<azure-openai-runtime-app-client-id>
   AZURE_CLIENT_SECRET=<azure-openai-runtime-app-secret-value>
   ```

`DefaultAzureCredential` uses these environment credentials before Azure CLI, so
the local operator does not need `az login` or a personal role assignment.

Do not reuse `ENTRA_CLIENT_ID` or `ENTRA_CLIENT_SECRET`. The `ENTRA_*` app signs
browser users into Work IQ; the separate `AZURE_*` identity only invokes models
on the one Azure OpenAI resource. Store both secrets outside source control and
rotate them independently.

The administrator creating the identity or assigning Azure RBAC needs the
corresponding temporary management permissions. The person running the
application does not.

#### Hosted option: managed identity

For an Azure-hosted run:

1. Enable a managed identity on the compute resource.
2. Assign **Cognitive Services OpenAI User** to that managed identity at the
   Azure OpenAI resource scope.
3. For a user-assigned managed identity, set `AZURE_CLIENT_ID` to that managed
   identity's client ID. A system-assigned managed identity needs no credential
   environment variables.

`DefaultAzureCredential` selects the explicitly configured service principal,
managed identity, or local Azure CLI identity. This Azure identity is separate
from the delegated Work IQ user and Entra app. The Work IQ bearer token is never
sent to Azure OpenAI.

Role assignments can take several minutes to propagate.

### 4. Configure exact deployment names

Copy the resource base endpoint from **Keys and Endpoint**. Do not copy an API
key; the application uses Microsoft Entra authentication.

```dotenv
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=workiq-orchestrator
AZURE_OPENAI_DEPLOYMENTS=workiq-orchestrator
AZURE_OPENAI_API_VERSION=2024-10-21
```

`AZURE_OPENAI_DEPLOYMENT` is the default. To offer more deployments in the model
picker, list their exact names:

```dotenv
AZURE_OPENAI_DEPLOYMENTS=workiq-orchestrator,workiq-orchestrator-alt
```

Every listed name must be a deployment on the endpoint in
`AZURE_OPENAI_ENDPOINT`, and the list must include the default deployment.

### 5. Verify authentication, network access, and every deployment

```bash
npm run config:verify
npm run azure-openai:verify
```

The second command uses the same `DefaultAzureCredential`, endpoint, API version,
and deployment names as the application. It makes one small, billable
tool-calling request per configured deployment and verifies that each deployment
supports the orchestration API. It never prints an access token.

Then start the application:

```bash
npm start
```

After delegated sign-in, select **Agent orchestrated**, open **Advanced setup**,
and verify that the deployment picker contains the expected names. Run a short
prompt. A successful response confirms the complete path from the browser
through Azure OpenAI to the selected Work IQ connection.

Common Azure OpenAI errors:

- **Credential unavailable or 401**: sign in with `az login` locally, or verify
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` for a dedicated
  local service principal, or verify the hosted managed identity.
- **403**: assign **Cognitive Services OpenAI User** to the actual runtime
  identity at the Azure OpenAI resource scope and allow propagation time.
- **404 / deployment not found**: use the deployment name, not the model name,
  and confirm it belongs to the configured endpoint.
- **Timeout or connection error**: verify firewall, selected-network, private
  endpoint, and DNS configuration.

Official references:

- [Create an Azure OpenAI resource and deploy a model](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource?pivots=web-portal)
- [Azure OpenAI role-based access control](https://learn.microsoft.com/azure/ai-services/openai/how-to/role-based-access-control)
- [DefaultAzureCredential for JavaScript](https://learn.microsoft.com/javascript/api/overview/azure/identity-readme#defaultazurecredential)

## Hosted deployment

The default loopback listener is the safest local configuration.

For hosting:

1. Terminate HTTPS at one trusted reverse proxy.
2. Block direct network access to the Node port.
3. Strip and replace forwarded headers at the proxy.
4. Store secrets in the platform's secret manager, not an image or repository.
5. Use:

   ```dotenv
   HOST=<private-listener-address>
   PORT=3000
   WORKIQ_ALLOW_REMOTE_BIND=true
   REDIRECT_URI=https://<approved-host>/auth/callback
   ```

6. Register that exact HTTPS callback in Entra.

`PORT` is the private Node listener behind the proxy. It does not need to match
the public HTTPS port in `REDIRECT_URI`.

The app trusts one proxy hop. Do not expose Node directly, chain untrusted
proxies, or use plain HTTP outside loopback.

## Troubleshooting

### `AADSTS50011`

The callback does not exactly match the Web redirect URI. Compare scheme, host,
port, and `/auth/callback`.

### Invalid client secret

Use the secret value, not its ID. Create a replacement, update the secret store
or `.env`, validate, test, and then delete the old credential.

### Work IQ returns 401 or 403

Check:

1. The signed-in user is assigned to the enterprise app.
2. The user is covered by the spending policy.
3. The first-party Work IQ enterprise app exists.
4. The lab app has only delegated `WorkIQAgent.Ask`.
5. Admin consent is granted in the correct tenant.
6. The configured tenant matches the signed-in account.
7. Propagation time has elapsed.
8. Existing Microsoft 365 permissions allow the requested data.

### Remote MCP is unavailable

REST and A2A can still work. Do not enable automatic local fallback. Local MCP
uses a separate CLI sign-in and requires explicit EULA acceptance.

### Configuration validation fails

- Generate `SESSION_SECRET` with `openssl rand -hex 32`; do not reuse the Entra
  client secret.
- For local use, `PORT` must match the loopback callback port.
- For hosting, `PORT` is the private Node listener and can differ from the public
  HTTPS callback port.
- A non-loopback `HOST` requires `WORKIQ_ALLOW_REMOTE_BIND=true` and an HTTPS
  `REDIRECT_URI`.
- If the port is already in use, choose another local port and update both
  `PORT` and the Entra redirect URI.

### Parent/child tenant authentication fails

This release is intentionally single-tenant. Users must sign in from the tenant
where the app is registered. Microsoft documents a multitenant app and
home-tenant authority for parent/child organizations; that topology requires an
application change and is not covered by this setup.

## Rotate or retire

To rotate a client secret:

1. Create the replacement.
2. Update the secret store or owner-only `.env`.
3. Validate and restart.
4. Test sign-in.
5. Remove the old secret.

To retire the lab:

1. Remove the dedicated app registration.
2. Remove its spending-policy group or retire the policy.
3. Delete `.env`, `.env.generated*`, and `.sessions` from the lab computer.
4. Remove Azure OpenAI assignments created only for the lab.
5. Restore MCP mutation policy if it was changed.
6. Keep the shared first-party Work IQ service principal if any other app uses
   it.
7. Deactivate any temporary Privileged Identity Management role activation.

## Official Microsoft sources

- [Work IQ permissions](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/permissions)
- [Enable a tenant for Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Work IQ API overview and licensing](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/api-overview)
- [Work IQ A2A quickstart](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/a2a/quickstart)
- [Work IQ MCP overview](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/overview)
- [Manage usage-based billing and role requirements](https://learn.microsoft.com/microsoft-365/copilot/usage-based-billing-manage-copilot-credits)
- [Microsoft Entra authorization-code flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Delegate app-management roles](https://learn.microsoft.com/entra/identity/role-based-access-control/delegate-app-roles)
- [Grant tenant-wide admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent)
- [Azure CLI admin-consent command](https://learn.microsoft.com/cli/azure/ad/app/permission#az-ad-app-permission-admin-consent)
- [Require enterprise-app assignment](https://learn.microsoft.com/entra/identity/enterprise-apps/assign-user-or-group-access-portal)
- [App credential security](https://learn.microsoft.com/entra/identity-platform/security-best-practices-for-app-registration)
- [Azure OpenAI role-based access control](https://learn.microsoft.com/azure/ai-services/openai/how-to/role-based-access-control)
