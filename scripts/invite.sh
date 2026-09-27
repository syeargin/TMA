#!/usr/bin/env bash
# Adds a team invite so an email can sign up (until the Invites screen ships in Phase 2).
# Run where the AWS CLI is signed in to the account, e.g. CloudShell.
#
#   scripts/invite.sh <env> <email> <teamId> <roles> [person] [pid]
#
#   scripts/invite.sh dev parent@example.com a5-13tom parent parent:p12:1 p12
#   scripts/invite.sh dev coach@example.com  a5-13tom coach,admin coach:0
#
# roles: comma-separated from admin, coach, coordinator, food, finance, parent
set -euo pipefail

if [[ $# -lt 4 ]]; then
  sed -n '2,11p' "$0"; exit 1
fi

ENV="$1"; EMAIL="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | xargs)"; TEAM="$3"; ROLES="$4"
PERSON="${5:-}"; PID="${6:-}"
TABLE="TeamHub-${ENV}"; REGION="${AWS_REGION:-us-east-1}"

VALID="admin coach coordinator food finance parent"
ROLE_LIST=""
IFS=',' read -r -a RS <<< "$ROLES"
for r in "${RS[@]}"; do
  r="$(printf '%s' "$r" | xargs)"
  [[ " $VALID " == *" $r "* ]] || { echo "error: unknown role '$r' (use: $VALID)" >&2; exit 1; }
  ROLE_LIST+="{\"S\":\"$r\"},"
done
ROLE_LIST="[${ROLE_LIST%,}]"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TTL="$(( $(date +%s) + 60*60*24*60 ))"   # unused invites expire after 60 days

aws dynamodb put-item --region "$REGION" --table-name "$TABLE" --item "{
  \"PK\": {\"S\": \"INVITE#$EMAIL\"},
  \"SK\": {\"S\": \"TEAM#$TEAM\"},
  \"type\": {\"S\": \"Invite\"},
  \"teamId\": {\"S\": \"$TEAM\"},
  \"email\": {\"S\": \"$EMAIL\"},
  \"roles\": {\"L\": $ROLE_LIST},
  \"person\": {\"S\": \"$PERSON\"},
  \"pid\": {\"S\": \"$PID\"},
  \"invitedBy\": {\"S\": \"cli\"},
  \"at\": {\"S\": \"$NOW\"},
  \"ttl\": {\"N\": \"$TTL\"},
  \"GSI1PK\": {\"S\": \"TEAM#$TEAM\"},
  \"GSI1SK\": {\"S\": \"INVITE#$EMAIL\"}
}"
echo "Invited $EMAIL to $TEAM as $ROLES in $TABLE. They can now create an account."
