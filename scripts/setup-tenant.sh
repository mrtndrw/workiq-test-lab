#!/usr/bin/env bash
set -Eeuo pipefail

WORKIQ_APP_ID="fdcc1f02-fc51-4226-8753-f668596af7f7"
WORKIQ_SCOPE_ID="0b1715fd-f4bf-4c63-b16d-5be31f9847c2"
WORKIQ_SCOPE_VALUE="WorkIQAgent.Ask"
APP_NAME="Work IQ Test Lab"
REDIRECT_URI="http://localhost:3000/auth/callback"
OUTPUT_ENV=".env.generated"
TENANT_ID=""
CONFIRM_TENANT=""
ACCESS_GROUP_ID=""
APPLY=0
ACKNOWLEDGE_GLOBAL_ADMIN=0
CREATED_APP_ID=""
TEMP_ENV=""
RETRY_ATTEMPTS=8
RETRY_DELAY_SECONDS="${WORKIQ_SETUP_RETRY_DELAY_SECONDS:-2}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/setup-tenant.sh --tenant-id <uuid> [options]

Read-only validation is the default. To make changes, add:
  --apply --confirm-tenant <same-tenant-uuid> --acknowledge-global-admin

Options:
  --tenant-id <uuid>       Expected Microsoft Entra tenant (required)
  --confirm-tenant <uuid>  Second explicit tenant check required with --apply
  --access-group-id <uuid> Security group allowed to sign in (required with --apply)
  --app-name <name>        New, dedicated app name
  --redirect-uri <url>     Callback URL (default: http://localhost:3000/auth/callback)
  --output-env <path>      New secret file (default: .env.generated)
  --apply                  Create missing Work IQ SP, a scoped app, consent, and secret
  --acknowledge-global-admin
                           Confirm temporary Global Administrator is active.
                           Azure CLI requires it for admin-consent.
  --help                   Show this help

The script never updates or deletes an existing app registration. It does not
configure billing or MCP mutation policy because Microsoft documents those as
admin-center operations.
EOF
}

cleanup() {
  if [[ -n "$TEMP_ENV" && -f "$TEMP_ENV" ]]; then
    rm -f -- "$TEMP_ENV"
  fi
}

report_partial_setup() {
  if [[ -n "$CREATED_APP_ID" ]]; then
    printf 'Setup stopped after creating app %s. No automatic deletion was attempted.\n' "$CREATED_APP_ID" >&2
    if [[ -f "$OUTPUT_ENV" ]]; then
      printf 'The generated client secret was preserved in the owner-only file: %s\n' "$OUTPUT_ENV" >&2
    fi
    printf 'Review that dedicated app in Microsoft Entra before retrying.\n' >&2
  fi
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  report_partial_setup
  exit 1
}

on_error() {
  local exit_code=$?
  report_partial_setup
  exit "$exit_code"
}

trap cleanup EXIT
trap on_error ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)
      [[ $# -ge 2 ]] || fail "--tenant-id requires a value."
      TENANT_ID="$2"
      shift 2
      ;;
    --confirm-tenant)
      [[ $# -ge 2 ]] || fail "--confirm-tenant requires a value."
      CONFIRM_TENANT="$2"
      shift 2
      ;;
    --access-group-id)
      [[ $# -ge 2 ]] || fail "--access-group-id requires a value."
      ACCESS_GROUP_ID="$2"
      shift 2
      ;;
    --app-name)
      [[ $# -ge 2 ]] || fail "--app-name requires a value."
      APP_NAME="$2"
      shift 2
      ;;
    --redirect-uri)
      [[ $# -ge 2 ]] || fail "--redirect-uri requires a value."
      REDIRECT_URI="$2"
      shift 2
      ;;
    --output-env)
      [[ $# -ge 2 ]] || fail "--output-env requires a value."
      OUTPUT_ENV="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --acknowledge-global-admin)
      ACKNOWLEDGE_GLOBAL_ADMIN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
[[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]] ||
  fail "WORKIQ_SETUP_RETRY_DELAY_SECONDS must be a non-negative integer."
[[ "$TENANT_ID" =~ $UUID_PATTERN ]] || fail "--tenant-id must be a tenant UUID."
if [[ "$APPLY" -eq 1 ]]; then
  [[ "$CONFIRM_TENANT" == "$TENANT_ID" ]] || fail "--confirm-tenant must exactly match --tenant-id when --apply is used."
  [[ "$ACCESS_GROUP_ID" =~ $UUID_PATTERN ]] ||
    fail "--access-group-id must be a security-group object UUID when --apply is used."
  [[ "$ACKNOWLEDGE_GLOBAL_ADMIN" -eq 1 ]] ||
    fail "--apply requires --acknowledge-global-admin because Azure CLI admin-consent requires temporary Global Administrator."
elif [[ -n "$ACCESS_GROUP_ID" ]]; then
  [[ "$ACCESS_GROUP_ID" =~ $UUID_PATTERN ]] || fail "--access-group-id must be a security-group object UUID."
fi
[[ "$APP_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._\ \(\)-]{2,79}$ ]] ||
  fail "--app-name must be 3-80 characters and use only letters, numbers, spaces, '.', '_', '(', ')' or '-'."
[[ "$OUTPUT_ENV" != *$'\n'* && "$OUTPUT_ENV" != *$'\r'* ]] || fail "--output-env contains an invalid newline."
[[ ! -e "$OUTPUT_ENV" && ! -L "$OUTPUT_ENV" ]] || fail "Refusing to overwrite existing output path: $OUTPUT_ENV"

for command_name in az node npm openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is not installed: $command_name"
done
(
  cd "$SCRIPT_DIR/.."
  node -e "import('dotenv').catch(() => process.exit(1))"
) >/dev/null 2>&1 ||
  fail "Runtime dependencies are missing. Run 'npm ci' from the repository root before tenant setup."

REDIRECT_URI="$(
  REDIRECT_URI="$REDIRECT_URI" node <<'EOF'
const value = process.env.REDIRECT_URI;
let url;
try {
  url = new URL(value);
} catch {
  process.stderr.write('ERROR: --redirect-uri must be an absolute URL.\n');
  process.exit(1);
}
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
if (url.username || url.password || url.search || url.hash) {
  process.stderr.write('ERROR: --redirect-uri cannot contain credentials, a query, or a fragment.\n');
  process.exit(1);
}
if (url.pathname !== '/auth/callback') {
  process.stderr.write('ERROR: --redirect-uri must use the /auth/callback path.\n');
  process.exit(1);
}
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) {
  process.stderr.write('ERROR: --redirect-uri must use HTTPS, except on a loopback host.\n');
  process.exit(1);
}
process.stdout.write(url.href);
EOF
)" || exit 1

OUTPUT_PARENT="$(dirname -- "$OUTPUT_ENV")"
[[ -d "$OUTPUT_PARENT" ]] || fail "Output directory does not exist: $OUTPUT_PARENT"
[[ -w "$OUTPUT_PARENT" ]] || fail "Output directory is not writable: $OUTPUT_PARENT"
PORT="$(
  REDIRECT_URI="$REDIRECT_URI" node -e \
    "const u=new URL(process.env.REDIRECT_URI);
     const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
     process.stdout.write(loopback.has(u.hostname) ? (u.port || (u.protocol === 'https:' ? '443' : '80')) : '3000')"
)"

ACCOUNT_JSON="$(az account show --only-show-errors -o json)" ||
  fail "Azure CLI is not signed in. Run: az login --tenant $TENANT_ID --allow-no-subscriptions"
ACTUAL_TENANT="$(printf '%s' "$ACCOUNT_JSON" | node -e "const a=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(a.tenantId || '')")"
ACCOUNT_TYPE="$(printf '%s' "$ACCOUNT_JSON" | node -e "const a=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(a.user?.type || '')")"
ACTUAL_TENANT_LOWER="$(printf '%s' "$ACTUAL_TENANT" | tr '[:upper:]' '[:lower:]')"
TENANT_ID_LOWER="$(printf '%s' "$TENANT_ID" | tr '[:upper:]' '[:lower:]')"
ACCOUNT_TYPE_LOWER="$(printf '%s' "$ACCOUNT_TYPE" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_TENANT_LOWER" == "$TENANT_ID_LOWER" ]] ||
  fail "Azure CLI is signed in to tenant $ACTUAL_TENANT, not the expected tenant $TENANT_ID."
[[ "$ACCOUNT_TYPE_LOWER" == "user" ]] ||
  fail "Use an interactive administrator account; current Azure CLI identity type is '$ACCOUNT_TYPE'."

if [[ -n "$ACCESS_GROUP_ID" ]]; then
  ACCESS_GROUP_JSON="$(
    az ad group show \
      --group "$ACCESS_GROUP_ID" \
      --only-show-errors \
      --query '{id:id,displayName:displayName,securityEnabled:securityEnabled}' \
      -o json
  )" || fail "The access group could not be read in tenant $TENANT_ID."
  ACCESS_GROUP_ID="$ACCESS_GROUP_ID" node -e "
    const group = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const valid =
      String(group.id || '').toLowerCase() === process.env.ACCESS_GROUP_ID.toLowerCase() &&
      group.securityEnabled === true &&
      typeof group.displayName === 'string' &&
      /^[^\r\n]{1,256}$/.test(group.displayName);
    process.exit(valid ? 0 : 1);
  " <<<"$ACCESS_GROUP_JSON" ||
    fail "--access-group-id must identify a security-enabled group in the expected tenant."
  ACCESS_GROUP_NAME="$(
    printf '%s' "$ACCESS_GROUP_JSON" |
      node -e "const g=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(g.displayName || '')"
  )"
fi

EXISTING_APPS_JSON="$(az ad app list --display-name "$APP_NAME" --only-show-errors -o json)"
EXISTING_APP_COUNT="$(
  APP_NAME="$APP_NAME" node -e \
    "const a=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(a.filter(x => x.displayName === process.env.APP_NAME).length))" \
    <<<"$EXISTING_APPS_JSON"
)"
[[ "$EXISTING_APP_COUNT" == "0" ]] ||
  fail "An app named '$APP_NAME' already exists. This script never modifies existing registrations; choose a unique name or configure the existing app manually."

WORKIQ_SP_COUNT="$(
  az ad sp list \
    --filter "appId eq '$WORKIQ_APP_ID'" \
    --only-show-errors \
    --query 'length(@)' \
    -o tsv
)"
[[ "$WORKIQ_SP_COUNT" =~ ^[01]$ ]] ||
  fail "Expected zero or one Work IQ service principals, found '$WORKIQ_SP_COUNT'."
WORKIQ_SP_EXISTS="$WORKIQ_SP_COUNT"

printf 'Validated Azure CLI tenant: %s\n' "$TENANT_ID"
printf 'Validated dedicated app name is unused: %s\n' "$APP_NAME"
printf 'Validated redirect URI: %s\n' "$REDIRECT_URI"
if [[ -n "$ACCESS_GROUP_ID" ]]; then
  printf 'Validated security access group: %s (%s)\n' "$ACCESS_GROUP_NAME" "$ACCESS_GROUP_ID"
else
  printf 'Apply mode will require a security access group before any tenant changes are made.\n'
fi
if [[ "$WORKIQ_SP_EXISTS" -eq 1 ]]; then
  printf 'Work IQ service principal already exists.\n'
else
  printf 'Work IQ service principal is not present and would be created.\n'
fi

if [[ "$APPLY" -eq 0 ]]; then
  printf '\nDry run complete: no tenant changes were made.\n'
  printf 'Billing and user spending-policy assignment must still be verified in the Microsoft 365 admin center.\n'
  printf 'Re-run with --apply --confirm-tenant %s --acknowledge-global-admin after reviewing the plan.\n' "$TENANT_ID"
  exit 0
fi

if [[ "$WORKIQ_SP_EXISTS" -eq 0 ]]; then
  az ad sp create --id "$WORKIQ_APP_ID" --only-show-errors -o none
fi

WORKIQ_SP_OBJECT_ID=""
DISCOVERED_SCOPE_ID=""
attempt=1
while [[ "$attempt" -le "$RETRY_ATTEMPTS" ]]; do
  if WORKIQ_SP_OBJECT_ID="$(
    az ad sp show --id "$WORKIQ_APP_ID" --only-show-errors --query id -o tsv
  )" && DISCOVERED_SCOPE_ID="$(
    az ad sp show --id "$WORKIQ_APP_ID" --only-show-errors \
      --query "oauth2PermissionScopes[?value=='$WORKIQ_SCOPE_VALUE' && isEnabled].id | [0]" -o tsv
  )" && [[ "$WORKIQ_SP_OBJECT_ID" =~ $UUID_PATTERN && "$DISCOVERED_SCOPE_ID" == "$WORKIQ_SCOPE_ID" ]]; then
    break
  fi
  if [[ "$attempt" -lt "$RETRY_ATTEMPTS" ]]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
[[ "$WORKIQ_SP_OBJECT_ID" =~ $UUID_PATTERN ]] ||
  fail "Azure CLI did not return a valid Work IQ service-principal object ID."
[[ "$DISCOVERED_SCOPE_ID" == "$WORKIQ_SCOPE_ID" ]] ||
  fail "Work IQ scope validation failed. Expected $WORKIQ_SCOPE_ID, found '${DISCOVERED_SCOPE_ID:-none}'."

CREATED_APP_JSON="$(
  az ad app create \
    --display-name "$APP_NAME" \
    --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "$REDIRECT_URI" \
    --only-show-errors \
    --query '{objectId:id,appId:appId}' \
    -o json
)"
CREATED_APP_OBJECT_ID="$(
  printf '%s' "$CREATED_APP_JSON" | node -e "const a=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(a.objectId || '')"
)"
CREATED_APP_ID="$(
  printf '%s' "$CREATED_APP_JSON" | node -e "const a=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(a.appId || '')"
)"
[[ "$CREATED_APP_OBJECT_ID" =~ $UUID_PATTERN && "$CREATED_APP_ID" =~ $UUID_PATTERN ]] ||
  fail "Azure CLI did not return valid identifiers for the new app."

CLIENT_SP_OBJECT_ID="$(
  az ad sp create --id "$CREATED_APP_ID" --only-show-errors --query id -o tsv
)"
[[ "$CLIENT_SP_OBJECT_ID" =~ $UUID_PATTERN ]] ||
  fail "Azure CLI did not return a valid client service-principal object ID."

az rest \
  --method PATCH \
  --only-show-errors \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$CLIENT_SP_OBJECT_ID" \
  --headers 'Content-Type=application/json' \
  --body '{"appRoleAssignmentRequired":true}' \
  -o none

ASSIGNMENT_BODY="$(
  ACCESS_GROUP_ID="$ACCESS_GROUP_ID" CLIENT_SP_OBJECT_ID="$CLIENT_SP_OBJECT_ID" node -e "
    process.stdout.write(JSON.stringify({
      principalId: process.env.ACCESS_GROUP_ID,
      resourceId: process.env.CLIENT_SP_OBJECT_ID,
      appRoleId: '00000000-0000-0000-0000-000000000000',
    }));
  "
)"
az rest \
  --method POST \
  --only-show-errors \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$CLIENT_SP_OBJECT_ID/appRoleAssignedTo" \
  --headers 'Content-Type=application/json' \
  --body "$ASSIGNMENT_BODY" \
  -o none

ACCESS_ASSIGNMENT_IS_VALID=0
attempt=1
while [[ "$attempt" -le "$RETRY_ATTEMPTS" ]]; do
  if CLIENT_SP_JSON="$(
    az ad sp show \
      --id "$CREATED_APP_ID" \
      --only-show-errors \
      --query '{id:id,appId:appId,appRoleAssignmentRequired:appRoleAssignmentRequired}' \
      -o json
  )" && ASSIGNMENTS_JSON="$(
    az rest \
      --method GET \
      --only-show-errors \
      --url "https://graph.microsoft.com/v1.0/servicePrincipals/$CLIENT_SP_OBJECT_ID/appRoleAssignedTo?\$select=principalId,resourceId,appRoleId" \
      -o json
  )" && CREATED_APP_ID="$CREATED_APP_ID" CLIENT_SP_OBJECT_ID="$CLIENT_SP_OBJECT_ID" ACCESS_GROUP_ID="$ACCESS_GROUP_ID" CLIENT_SP_JSON="$CLIENT_SP_JSON" ASSIGNMENTS_JSON="$ASSIGNMENTS_JSON" node -e "
    const servicePrincipal = JSON.parse(process.env.CLIENT_SP_JSON);
    const assignments = JSON.parse(process.env.ASSIGNMENTS_JSON).value || [];
    const zeroRole = '00000000-0000-0000-0000-000000000000';
    const valid =
      servicePrincipal.id === process.env.CLIENT_SP_OBJECT_ID &&
      servicePrincipal.appId === process.env.CREATED_APP_ID &&
      servicePrincipal.appRoleAssignmentRequired === true &&
      assignments.length === 1 &&
      assignments[0].principalId === process.env.ACCESS_GROUP_ID &&
      assignments[0].resourceId === process.env.CLIENT_SP_OBJECT_ID &&
      assignments[0].appRoleId === zeroRole;
    process.exit(valid ? 0 : 1);
  "; then
    ACCESS_ASSIGNMENT_IS_VALID=1
    break
  fi
  if [[ "$attempt" -lt "$RETRY_ATTEMPTS" ]]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
if [[ "$ACCESS_ASSIGNMENT_IS_VALID" -ne 1 ]]; then
  fail "The new enterprise app was not restricted exclusively to the approved security group."
fi

CREATED_APP_IS_VALID=0
attempt=1
while [[ "$attempt" -le "$RETRY_ATTEMPTS" ]]; do
  if CREATED_APP_VALIDATION="$(
    az ad app show \
      --id "$CREATED_APP_ID" \
      --only-show-errors \
      --query '{appId:appId,displayName:displayName,signInAudience:signInAudience,redirectUris:web.redirectUris,isFallbackPublicClient:isFallbackPublicClient}' \
      -o json
  )" && APP_NAME="$APP_NAME" CREATED_APP_ID="$CREATED_APP_ID" REDIRECT_URI="$REDIRECT_URI" node -e "
    const app = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const valid =
      app.appId === process.env.CREATED_APP_ID &&
      app.displayName === process.env.APP_NAME &&
      app.signInAudience === 'AzureADMyOrg' &&
      app.isFallbackPublicClient !== true &&
      Array.isArray(app.redirectUris) &&
      app.redirectUris.length === 1 &&
      app.redirectUris[0] === process.env.REDIRECT_URI;
    process.exit(valid ? 0 : 1);
  " <<<"$CREATED_APP_VALIDATION"; then
    CREATED_APP_IS_VALID=1
    break
  fi
  if [[ "$attempt" -lt "$RETRY_ATTEMPTS" ]]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
if [[ "$CREATED_APP_IS_VALID" -ne 1 ]]; then
  fail "The new app's tenant audience, public-client setting, or redirect URI did not match the approved configuration."
fi

az ad app permission add \
  --id "$CREATED_APP_ID" \
  --api "$WORKIQ_APP_ID" \
  --api-permissions "$WORKIQ_SCOPE_ID=Scope" \
  --only-show-errors \
  -o none

PERMISSION_IS_VALID=0
attempt=1
while [[ "$attempt" -le "$RETRY_ATTEMPTS" ]]; do
  if PERMISSIONS_JSON="$(
    az ad app permission list --id "$CREATED_APP_ID" --only-show-errors -o json
  )" && WORKIQ_APP_ID="$WORKIQ_APP_ID" WORKIQ_SCOPE_ID="$WORKIQ_SCOPE_ID" node -e "
    const permissions = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const valid =
      permissions.length === 1 &&
      permissions[0].resourceAppId === process.env.WORKIQ_APP_ID &&
      Array.isArray(permissions[0].resourceAccess) &&
      permissions[0].resourceAccess.length === 1 &&
      permissions[0].resourceAccess[0].id === process.env.WORKIQ_SCOPE_ID &&
      permissions[0].resourceAccess[0].type === 'Scope';
    process.exit(valid ? 0 : 1);
  " <<<"$PERMISSIONS_JSON"; then
    PERMISSION_IS_VALID=1
    break
  fi
  if [[ "$attempt" -lt "$RETRY_ATTEMPTS" ]]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
if [[ "$PERMISSION_IS_VALID" -ne 1 ]]; then
  fail "The new app must contain only the WorkIQAgent.Ask delegated permission."
fi

az ad app permission admin-consent --id "$CREATED_APP_ID" --only-show-errors

CONSENT_IS_VALID=0
attempt=1
while [[ "$attempt" -le "$RETRY_ATTEMPTS" ]]; do
  if GRANTS_JSON="$(
    az rest --method GET --only-show-errors \
      --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId%20eq%20'$CLIENT_SP_OBJECT_ID'%20and%20resourceId%20eq%20'$WORKIQ_SP_OBJECT_ID'" \
      -o json
  )" && WORKIQ_SCOPE_VALUE="$WORKIQ_SCOPE_VALUE" node -e "
    const response = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const grants = (response.value || []).filter((grant) => grant.consentType === 'AllPrincipals');
    const valid =
      grants.length === 1 &&
      String(grants[0].scope || '').trim() === process.env.WORKIQ_SCOPE_VALUE;
    process.exit(valid ? 0 : 1);
  " <<<"$GRANTS_JSON"; then
    CONSENT_IS_VALID=1
    break
  fi
  if [[ "$attempt" -lt "$RETRY_ATTEMPTS" ]]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
if [[ "$CONSENT_IS_VALID" -ne 1 ]]; then
  fail "Tenant-wide admin consent could not be verified for WorkIQAgent.Ask."
fi

SESSION_SECRET="$(openssl rand -hex 32)"
umask 077
TEMP_ENV="$(mktemp "${OUTPUT_ENV}.tmp.XXXXXX")"

CLIENT_SECRET="$(
  az ad app credential reset \
    --id "$CREATED_APP_ID" \
    --append \
    --display-name "Work IQ Test Lab setup" \
    --years 1 \
    --only-show-errors \
    --query password \
    -o tsv
)"
[[ ${#CLIENT_SECRET} -ge 16 && "$CLIENT_SECRET" != *$'\n'* && "$CLIENT_SECRET" != *$'\r'* ]] ||
  fail "Azure CLI did not return a valid client secret value."

ENTRA_TENANT_ID="$TENANT_ID" \
ENTRA_CLIENT_ID="$CREATED_APP_ID" \
ENTRA_CLIENT_SECRET="$CLIENT_SECRET" \
REDIRECT_URI="$REDIRECT_URI" \
SESSION_SECRET="$SESSION_SECRET" \
PORT="$PORT" \
node >"$TEMP_ENV" <<'EOF'
const values = {
  ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
  ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
  ENTRA_CLIENT_SECRET: process.env.ENTRA_CLIENT_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET,
  PORT: process.env.PORT,
  HOST: '127.0.0.1',
  NODE_ENV: 'production',
  WORKIQ_MCP_TRANSPORT: 'remote',
  WORKIQ_MCP_REMOTE_FALLBACK: 'off',
};
for (const [name, value] of Object.entries(values)) {
  process.stdout.write(`${name}=${JSON.stringify(value)}\n`);
}
EOF
chmod 600 "$TEMP_ENV"

ln -- "$TEMP_ENV" "$OUTPUT_ENV"
rm -f -- "$TEMP_ENV"
TEMP_ENV=""
node "$SCRIPT_DIR/verify-config.mjs" --env "$OUTPUT_ENV" ||
  fail "Generated credentials were preserved, but configuration validation failed."

printf '\nTenant setup completed and verified.\n'
printf 'Application (client) ID: %s\n' "$CREATED_APP_ID"
printf 'Sign-in is restricted to security group: %s (%s)\n' "$ACCESS_GROUP_NAME" "$ACCESS_GROUP_ID"
printf 'Secret configuration was written with owner-only permissions to: %s\n' "$OUTPUT_ENV"
printf 'The client secret expires in one year; record a rotation owner and date now.\n'
printf 'No billing or MCP mutation policy settings were changed.\n'
