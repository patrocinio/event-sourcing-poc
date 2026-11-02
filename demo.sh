#!/bin/bash
###############################################################################
# Aurora CQRS/Event Sourcing — Live Demo Script (Aurora Global Database,
# us-east-1 primary + us-west-2 secondary)
#
# This demonstrates CQRS/Event Sourcing on AWS with:
#   - API Gateway (REST API, IAM/SigV4 auth) + WAF in BOTH regions
#   - Lambda (TypeScript) for compute
#   - Aurora PostgreSQL Serverless v2 Global Database
#       us-east-1 writer  = event store (`events`) + projection writes
#       us-west-2 cluster = read-only replicas; writes are forwarded to the
#                           us-east-1 writer (global write forwarding)
#       each region's query side reads its LOCAL replica (`loans`)
#   - Kinesis Data Streams in us-east-1 (event distribution; drives the projector)
#
# Every API call is signed with SigV4 using your current AWS credentials
# (curl --aws-sigv4, curl >= 7.75). The caller needs execute-api:Invoke on both APIs.
#
# Usage:
#   ./demo.sh
#   (auto-discovers the endpoints from the LoanOriginationsAuroraPrimary /
#    LoanOriginationsAuroraSecondary stacks; override with
#    API_URL_EAST=... API_URL_WEST=...)
###############################################################################
# Don't exit on errors — this is an interactive demo script

REGION_EAST="us-east-1"
REGION_WEST="us-west-2"
STACK_EAST="LoanOriginationsAuroraPrimary"
STACK_WEST="LoanOriginationsAuroraSecondary"

stack_api_url() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$2" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null || echo ""
}

BASE_EAST="${API_URL_EAST:-$(stack_api_url "$STACK_EAST" "$REGION_EAST")}"
BASE_EAST="${BASE_EAST%/}"
BASE_WEST="${API_URL_WEST:-$(stack_api_url "$STACK_WEST" "$REGION_WEST")}"
BASE_WEST="${BASE_WEST%/}"

if [ -z "$BASE_EAST" ] || [ "$BASE_EAST" = "None" ]; then
  echo "  ERROR: Could not determine API URL ($REGION_EAST)."
  echo "  Set API_URL_EAST or deploy the $STACK_EAST stack."
  exit 1
fi
if [ -z "$BASE_WEST" ] || [ "$BASE_WEST" = "None" ]; then
  echo "  ERROR: Could not determine API URL ($REGION_WEST)."
  echo "  Set API_URL_WEST or deploy the $STACK_WEST stack."
  exit 1
fi

# Load the caller's credentials (profile, SSO, env, or instance role) as env vars.
if ! CREDS_ENV="$(aws configure export-credentials --format env 2>/dev/null)"; then
  echo "  ERROR: Could not export AWS credentials (aws configure export-credentials)."
  echo "  Log in / select a profile first (e.g. export AWS_PROFILE=...)."
  exit 1
fi
eval "$CREDS_ENV"
unset CREDS_ENV

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "  ERROR: AWS credentials are incomplete."
  exit 1
fi

BOLD=$'\033[1m'
GREEN=$'\033[1;32m'
CYAN=$'\033[1;36m'
YELLOW=$'\033[1;33m'
RED=$'\033[1;31m'
RESET=$'\033[0m'

base_url() {
  case "$1" in
    "$REGION_EAST") echo "$BASE_EAST" ;;
    "$REGION_WEST") echo "$BASE_WEST" ;;
    *) echo "" ;;
  esac
}

# Signed API call: api REGION METHOD PATH [JSON_BODY] [extra curl args...]
# Signs for the given region (aws:amz:<region>:execute-api) and calls that
# region's API base URL.
api() {
  local region="$1" method="$2" path="$3" body="${4:-}"
  if [ $# -ge 4 ]; then shift 4; else shift $#; fi
  local base
  base="$(base_url "$region")"
  local args=(-s -X "$method"
    --aws-sigv4 "aws:amz:${region}:execute-api"
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    args+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
  fi
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}" "$@" "${base}${path}"
}

pause() {
  echo ""
  read -rp "  ▶ Press ENTER to continue..." _
  echo ""
}

header() {
  echo ""
  printf "%b\n" "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  printf "%b\n" "${BOLD}  $1${RESET}"
  printf "%b\n" "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

step() {
  printf "%b\n" "  ${GREEN}→${RESET} $1"
}

explain() {
  printf "%b\n" "  ${YELLOW}ℹ${RESET} $1"
}

# Projector is asynchronous (Kinesis → Lambda → Aurora writer → replicas).
wait_for_projection() {
  sleep "${1:-3}"
}

# command_with_retry REGION PATH JSON_BODY
# POSTs a command; retries a few times on 404/409, which in the secondary
# region can mean the previous event has not replicated yet (stale read →
# version conflict → 409, or loan not visible yet → 404). Prints the body.
command_with_retry() {
  local region="$1" path="$2" body="$3" out code resp i
  for i in 1 2 3 4 5; do
    out="$(api "$region" POST "$path" "$body" -w $'\n%{http_code}')"
    code="$(printf '%s\n' "$out" | tail -n 1)"
    resp="$(printf '%s\n' "$out" | sed '$d')"
    if [ "$code" != "404" ] && [ "$code" != "409" ]; then
      break
    fi
    explain "HTTP ${code} from ${region} (replication lag?) — retry ${i}/5..." >&2
    sleep 1
  done
  printf '%s\n' "$resp"
}

# read_until_status REGION LOAN_ID STATUS
# Reads the loan from REGION's local read replica until it shows STATUS
# (projector + global replication lag), up to ~10 s. Prints the last body.
read_until_status() {
  local region="$1" id="$2" want="$3" resp status i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    resp="$(api "$region" GET "/api/loans/${id}")"
    status="$(printf '%s' "$resp" | jq -r '.status' 2>/dev/null)"
    if [ "$status" = "$want" ]; then
      printf '%s\n' "$resp"
      return 0
    fi
    sleep 1
  done
  printf '%s\n' "$resp"
  return 1
}

###############################################################################
header "AURORA GLOBAL DATABASE — CQRS & EVENT SOURCING DEMO"
###############################################################################

echo ""
echo "  This demo showcases a Loan Originations system built with:"
echo ""
echo "    • API Gateway     — REST API endpoints in 2 regions (IAM / SigV4 auth)"
echo "    • Lambda          — Command, Query & Projector handlers (TypeScript)"
echo "    • Aurora writer   — PostgreSQL event store (us-east-1, global primary)"
echo "    • Aurora replicas — Query side in each region (loans table)"
echo "    • Write forwarding— us-west-2 commands are forwarded to the writer"
echo "    • Kinesis Streams — Event distribution → Projector (us-east-1)"
echo ""
echo "  Multi-Region Architecture (Aurora Global Database):"
echo ""
echo "    us-east-1 (PRIMARY)                    us-west-2 (SECONDARY)"
echo "    API GW + WAF → Command λ / Query λ     API GW + WAF → Command λ / Query λ"
echo ""
echo "    Aurora WRITER (events + loans)  ◀───── cluster endpoint (write forwarding)"
echo "    Aurora READER (loans → queries)        2 replicas (loans → queries)"
echo "         │                                       ▲"
echo "         └──── global storage replication (< ~1 s) ┘"
echo ""
echo "    Kinesis (one stream, us-east-1) ◀── Command λ in BOTH regions publish"
echo "      └─▶ Projector λ: rebuild loan from the events table, upsert on WRITER"
echo ""
printf "%b\n" "  ${BOLD}API (us-east-1):${RESET}  ${BASE_EAST}"
printf "%b\n" "  ${BOLD}API (us-west-2):${RESET}  ${BASE_WEST}"

pause

###############################################################################
header "PART 0: SECURITY — Both APIs require IAM (SigV4) authentication"
###############################################################################

for REGION in "$REGION_EAST" "$REGION_WEST"; do
  step "Sending an UNSIGNED request to ${REGION}..."
  ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$(base_url "$REGION")/api/loans")
  if [ "$ANON_CODE" = "403" ]; then
    printf "%b\n" "  ${GREEN}HTTP ${ANON_CODE}${RESET} — unsigned callers are rejected by API Gateway (${REGION})."
  else
    printf "%b\n" "  ${RED}HTTP ${ANON_CODE}${RESET} — expected 403. Check the ${REGION} API's authorization settings!"
  fi
  echo ""
done

for REGION in "$REGION_EAST" "$REGION_WEST"; do
  step "Sending a SIGNED request (health check, ${REGION})..."
  api "$REGION" GET "/api/loans/health" | jq '.' 2>/dev/null
  echo ""
done
explain "Every call below is signed with your AWS credentials (curl --aws-sigv4)."
explain "Each health check runs SELECT 1 against that region's local READER endpoint."

pause

###############################################################################
header "PART 1: COMMAND SIDE — Submit Loan Application (us-east-1)"
###############################################################################

explain "Commands go to the Command Lambda, which:"
explain "  1. Replays events from the Aurora writer (events table) to rebuild state"
explain "  2. Validates business rules"
explain "  3. INSERTs the new event — PK (aggregate_id, version) = optimistic concurrency"
explain "  4. Publishes the event to Kinesis after the commit"
echo ""

step "Sending SubmitLoan command to us-east-1..."
echo ""
RESULT=$(api "$REGION_EAST" POST "/api/loans" \
  '{"applicantName":"Maria Garcia","requestedAmount":120000,"purpose":"Home Purchase"}')
echo "  Response:"
echo "  $RESULT" | jq '.' 2>/dev/null || echo "  $RESULT"

LOAN_ID=$(echo "$RESULT" | jq -r '.loanId' 2>/dev/null)

echo ""
explain "Behind the scenes:"
explain "  1. API Gateway (IAM auth) → Command Lambda"
explain "  2. Lambda wrote LoanApplicationSubmitted to the events table (Aurora writer)"
explain "  3. Lambda published the event to Kinesis"
explain "  4. Kinesis triggered the Projector Lambda"
explain "  5. Projector rebuilt the loans row from the events table and upserted it"

pause

###############################################################################
header "PART 2: QUERY SIDE — Read from Projection (us-east-1 reader)"
###############################################################################

explain "Queries go to the Query Lambda, which reads the loans table"
explain "through the region-local Aurora READER endpoint — never the event store."
explain "This is CQRS: write path and read path are separate."
echo ""

step "Querying loan by ID..."
echo ""
wait_for_projection 3
api "$REGION_EAST" GET "/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

echo ""
explain "The Query Lambda never touches the events table."
explain "It reads the pre-computed loans projection from the reader instance."

pause

###############################################################################
header "PART 3: BUSINESS RULES — State Machine Enforcement"
###############################################################################

explain "The Command Lambda enforces invariants by replaying events first."
echo ""

step "Attempting invalid transition: disburse a SUBMITTED loan..."
echo ""
api "$REGION_EAST" POST "/api/loans/${LOAN_ID}/disburse" \
  '{"disbursementAccount":"ACCT-999"}' | jq '.' 2>/dev/null

echo ""
explain "HTTP 409: 'Can only disburse an APPROVED loan'"
explain "The Lambda replayed events → state=SUBMITTED → rejected command."

pause

###############################################################################
header "PART 4: FULL LIFECYCLE — Submit → Approve → Disburse (us-east-1)"
###############################################################################

step "Approving..."
api "$REGION_EAST" POST "/api/loans/${LOAN_ID}/approve" \
  '{"approvedAmount":115000,"approvedBy":"Sarah Chen (VP Lending)"}' | jq '.' 2>/dev/null
echo ""

step "Disbursing..."
api "$REGION_EAST" POST "/api/loans/${LOAN_ID}/disburse" \
  '{"disbursementAccount":"ACH-0012345678"}' | jq '.' 2>/dev/null
echo ""

step "Final state from projection (us-east-1 reader):"
read_until_status "$REGION_EAST" "$LOAN_ID" "DISBURSED" | jq '.' 2>/dev/null

echo ""
explain "The Aurora events table now has 3 rows for this aggregate:"
explain "  v1: LoanApplicationSubmitted"
explain "  v2: LoanApproved"
explain "  v3: LoanDisbursed"

pause

###############################################################################
header "PART 5: EVENT SOURCING — Different Paths Coexist"
###############################################################################

step "Submitting a second loan and rejecting it..."
echo ""
RESULT2=$(api "$REGION_EAST" POST "/api/loans" \
  '{"applicantName":"James Wilson","requestedAmount":500000,"purpose":"Speculative Investment"}')
LOAN_ID2=$(echo "$RESULT2" | jq -r '.loanId' 2>/dev/null)

api "$REGION_EAST" POST "/api/loans/${LOAN_ID2}/reject" \
  '{"reason":"Amount exceeds risk threshold","rejectedBy":"Risk Engine (automated)"}' | jq '.' 2>/dev/null

echo ""
explain "Both paths are stored permanently in the Aurora events table."
explain "SUBMITTED→APPROVED→DISBURSED and SUBMITTED→REJECTED coexist."
explain "The loans projection can be rebuilt at any time by replaying events."

pause

###############################################################################
header "PART 6: QUERY BY STATUS"
###############################################################################

wait_for_projection 3
step "All loans:"
api "$REGION_EAST" GET "/api/loans" | jq '.' 2>/dev/null
echo ""

step "DISBURSED only:"
api "$REGION_EAST" GET "/api/loans/status/DISBURSED" | jq '.' 2>/dev/null
echo ""

step "REJECTED only:"
api "$REGION_EAST" GET "/api/loans/status/REJECTED" | jq '.' 2>/dev/null

pause

###############################################################################
header "PART 7: CROSS-REGION — Submit east, approve west, disburse east"
###############################################################################

explain "One Aurora writer (us-east-1), APIs in both regions:"
explain "  • us-west-2 commands write through the secondary cluster endpoint;"
explain "    Aurora forwards the INSERT to the us-east-1 writer (write forwarding)."
explain "  • Each region's queries read its LOCAL replica (global replication < ~1 s)."
explain "  • A stale read in us-west-2 can only cause a 409 (PK conflict) → retry."
echo ""

step "1) Submit in ${BOLD}us-east-1${RESET}..."
XR=$(api "$REGION_EAST" POST "/api/loans" \
  '{"applicantName":"Ana Souza","requestedAmount":75000,"purpose":"Small Business"}')
echo "  $XR" | jq '.' 2>/dev/null || echo "  $XR"
XLOAN=$(echo "$XR" | jq -r '.loanId' 2>/dev/null)
echo ""

step "2) Approve in ${BOLD}us-west-2${RESET} (write forwarded to the us-east-1 writer)..."
command_with_retry "$REGION_WEST" "/api/loans/${XLOAN}/approve" \
  '{"approvedAmount":70000,"approvedBy":"Oregon Credit Desk"}' | jq '.' 2>/dev/null
echo ""

step "3) Disburse in ${BOLD}us-east-1${RESET} (reads v2 directly on the writer)..."
command_with_retry "$REGION_EAST" "/api/loans/${XLOAN}/disburse" \
  '{"disbursementAccount":"ACH-7700112233"}' | jq '.' 2>/dev/null
echo ""

step "4) Read the loan from BOTH regions' read replicas..."
echo ""
for REGION in "$REGION_EAST" "$REGION_WEST"; do
  printf "%b\n" "  ${BOLD}${REGION} replica:${RESET}"
  if OUT="$(read_until_status "$REGION" "$XLOAN" "DISBURSED")"; then
    printf '%s\n' "$OUT" | jq '.' 2>/dev/null
    printf "%b\n" "  ${GREEN}✓${RESET} DISBURSED visible in ${REGION}"
  else
    printf '%s\n' "$OUT" | jq '.' 2>/dev/null
    printf "%b\n" "  ${RED}✗${RESET} not DISBURSED yet in ${REGION} (projector/replication lag) — re-run the GET"
  fi
  echo ""
done

explain "events v1 (east), v2 (west, forwarded), v3 (east) all live on the single writer."
explain "The projector (us-east-1 only) rebuilds the loan from the full event history,"
explain "so out-of-order Kinesis delivery from two regions cannot corrupt the view."

pause

###############################################################################
header "PART 8: AWS SERVICES vs AXON FRAMEWORK — Comparison"
###############################################################################

echo ""
echo "  ┌─────────────────────┬─────────────────────┬──────────────────────────┐"
echo "  │ Concern             │ Axon Framework      │ AWS (aurora branch)      │"
echo "  ├─────────────────────┼─────────────────────┼──────────────────────────┤"
echo "  │ Event Store         │ Axon Server         │ Aurora Global DB writer  │"
echo "  │ Event Routing       │ Axon Server         │ Kinesis Streams          │"
echo "  │ Command Handling    │ @CommandHandler     │ Lambda (2 regions)       │"
echo "  │ Query Handling      │ @QueryHandler       │ Lambda (2 regions)       │"
echo "  │ Projections         │ @EventHandler       │ Kinesis → Projector λ    │"
echo "  │ Read Model          │ In-memory HashMap   │ Aurora replica per region│"
echo "  │ API                 │ Spring Boot         │ API Gateway (IAM auth)   │"
echo "  │ Deployment          │ EKS (containers)    │ Serverless (Lambda)      │"
echo "  │ Scaling             │ Manual (pods)       │ Automatic (ACUs)         │"
echo "  │ Cost Model          │ Always-on           │ Per-ACU-hour + requests  │"
echo "  └─────────────────────┴─────────────────────┴──────────────────────────┘"
echo ""
explain "Same pattern (CQRS/ES), different implementation."
explain "Aurora approach: SQL event store + SQL read model, serverless compute,"
explain "one writer region with write forwarding and region-local reads."
echo ""
printf "%b\n" "  ${GREEN}Demo complete!${RESET}"
echo ""
