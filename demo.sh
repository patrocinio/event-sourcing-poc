#!/bin/bash
###############################################################################
# Aurora CQRS/Event Sourcing — Live Demo Script (single region, us-east-1)
#
# This demonstrates CQRS/Event Sourcing on AWS with:
#   - API Gateway (REST API, IAM/SigV4 auth) + WAF
#   - Lambda (TypeScript) for compute
#   - Aurora PostgreSQL Serverless v2
#       writer instance  = event store (`events`) + projection writes
#       reader instance  = query side (`loans` projection)
#   - Kinesis Data Streams (event distribution; drives the projector)
#
# Every API call is signed with SigV4 using your current AWS credentials
# (curl --aws-sigv4, curl >= 7.75). The caller needs execute-api:Invoke on the API.
#
# Usage:
#   ./demo.sh
#   (auto-discovers the endpoint from the LoanOriginationsAurora stack;
#    override with API_URL=...)
###############################################################################
# Don't exit on errors — this is an interactive demo script

REGION="us-east-1"
STACK_NAME="LoanOriginationsAurora"

BASE="${API_URL:-$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null || echo "")}"
BASE="${BASE%/}"

if [ -z "$BASE" ] || [ "$BASE" = "None" ]; then
  echo "  ERROR: Could not determine API URL ($REGION)."
  echo "  Set API_URL env var or deploy the $STACK_NAME stack."
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

# Signed API call: api METHOD PATH [JSON_BODY]
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method"
    --aws-sigv4 "aws:amz:${REGION}:execute-api"
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    args+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
  fi
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}" "${BASE}${path}"
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

# Projector is asynchronous (Kinesis → Lambda → Aurora writer → reader replica).
wait_for_projection() {
  sleep "${1:-3}"
}

###############################################################################
header "AURORA CQRS & EVENT SOURCING DEMO"
###############################################################################

echo ""
echo "  This demo showcases a Loan Originations system built with:"
echo ""
echo "    • API Gateway     — REST API endpoints (IAM / SigV4 auth)"
echo "    • Lambda          — Command, Query & Projector handlers (TypeScript)"
echo "    • Aurora writer   — PostgreSQL event store (events table)"
echo "    • Kinesis Streams — Event distribution → Projector"
echo "    • Aurora reader   — Query side (loans projection table)"
echo ""
echo "  Single-Region Architecture (us-east-1, 3 AZs):"
echo ""
echo "    Client (SigV4) ──▶ API Gateway + WAF"
echo "                         │"
echo "            ┌────────────┴────────────┐"
echo "            ▼                         ▼"
echo "    ┌──────────────┐          ┌──────────────┐"
echo "    │ Command λ    │          │  Query λ     │"
echo "    └──────┬───────┘          └──────▲───────┘"
echo "           │ INSERT event            │ SELECT loans"
echo "           ▼                         │"
echo "    ┌──────────────┐  replicate ┌──────────────┐"
echo "    │Aurora WRITER │───────────▶│Aurora READER │"
echo "    │ events,loans │            │   (loans)    │"
echo "    └──────┬───────┘            └──────────────┘"
echo "           │ publish                 ▲"
echo "           ▼                         │"
echo "      Kinesis ──▶ Projector λ ── upsert loans on WRITER"
echo ""
printf "%b\n" "  ${BOLD}API (us-east-1):${RESET}  ${BASE}"

pause

###############################################################################
header "PART 0: SECURITY — The API requires IAM (SigV4) authentication"
###############################################################################

step "Sending an UNSIGNED request..."
echo ""
ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/loans")
if [ "$ANON_CODE" = "403" ]; then
  printf "%b\n" "  ${GREEN}HTTP ${ANON_CODE}${RESET} — unsigned callers are rejected by API Gateway."
else
  printf "%b\n" "  ${RED}HTTP ${ANON_CODE}${RESET} — expected 403. Check the API's authorization settings!"
fi
echo ""
step "Sending a SIGNED request (health check)..."
echo ""
api GET "/api/loans/health" | jq '.' 2>/dev/null
echo ""
explain "Every call below is signed with your AWS credentials (curl --aws-sigv4)."
explain "The health check runs SELECT 1 against the Aurora READER endpoint."

pause

###############################################################################
header "PART 1: COMMAND SIDE — Submit Loan Application"
###############################################################################

explain "Commands go to the Command Lambda, which:"
explain "  1. Replays events from the Aurora writer (events table) to rebuild state"
explain "  2. Validates business rules"
explain "  3. INSERTs the new event — PK (aggregate_id, version) = optimistic concurrency"
explain "  4. Publishes the event to Kinesis after the commit"
echo ""

step "Sending SubmitLoan command..."
echo ""
RESULT=$(api POST "/api/loans" \
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
explain "  5. Projector upserted the loans row on the writer (guarded by last_version)"

pause

###############################################################################
header "PART 2: QUERY SIDE — Read from Projection"
###############################################################################

explain "Queries go to the Query Lambda, which reads the loans table"
explain "through the Aurora READER endpoint — never the event store."
explain "This is CQRS: write path and read path are separate."
echo ""

step "Querying loan by ID..."
echo ""
wait_for_projection 3
api GET "/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

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
api POST "/api/loans/${LOAN_ID}/disburse" \
  '{"disbursementAccount":"ACCT-999"}' | jq '.' 2>/dev/null

echo ""
explain "HTTP 409: 'Can only disburse an APPROVED loan'"
explain "The Lambda replayed events → state=SUBMITTED → rejected command."

pause

###############################################################################
header "PART 4: FULL LIFECYCLE — Submit → Approve → Disburse"
###############################################################################

step "Approving..."
api POST "/api/loans/${LOAN_ID}/approve" \
  '{"approvedAmount":115000,"approvedBy":"Sarah Chen (VP Lending)"}' | jq '.' 2>/dev/null
echo ""

step "Disbursing..."
api POST "/api/loans/${LOAN_ID}/disburse" \
  '{"disbursementAccount":"ACH-0012345678"}' | jq '.' 2>/dev/null
echo ""

step "Final state from projection (Aurora reader):"
wait_for_projection 3
api GET "/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

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
RESULT2=$(api POST "/api/loans" \
  '{"applicantName":"James Wilson","requestedAmount":500000,"purpose":"Speculative Investment"}')
LOAN_ID2=$(echo "$RESULT2" | jq -r '.loanId' 2>/dev/null)

api POST "/api/loans/${LOAN_ID2}/reject" \
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
api GET "/api/loans" | jq '.' 2>/dev/null
echo ""

step "DISBURSED only:"
api GET "/api/loans/status/DISBURSED" | jq '.' 2>/dev/null
echo ""

step "REJECTED only:"
api GET "/api/loans/status/REJECTED" | jq '.' 2>/dev/null

pause

###############################################################################
header "PART 7: SINGLE REGION — Why no cross-region active-active here"
###############################################################################

explain "An Aurora cluster has exactly ONE writer. Aurora Global Database"
explain "secondaries are read-only, so active-active writes (as on the"
explain "aws-native branch with DynamoDB Global Tables) are not possible."
explain "This branch runs in us-east-1 only, across 3 AZs (writer + reader"
explain "instances in different AZs, automatic failover to the reader)."

pause

###############################################################################
header "PART 8: AWS SERVICES vs AXON FRAMEWORK — Comparison"
###############################################################################

echo ""
echo "  ┌─────────────────────┬─────────────────────┬─────────────────────────┐"
echo "  │ Concern             │ Axon Framework      │ AWS (aurora branch)     │"
echo "  ├─────────────────────┼─────────────────────┼─────────────────────────┤"
echo "  │ Event Store         │ Axon Server         │ Aurora PG (writer)      │"
echo "  │ Event Routing       │ Axon Server         │ Kinesis Streams         │"
echo "  │ Command Handling    │ @CommandHandler     │ Lambda function         │"
echo "  │ Query Handling      │ @QueryHandler       │ Lambda function         │"
echo "  │ Projections         │ @EventHandler       │ Kinesis → Projector λ   │"
echo "  │ Read Model          │ In-memory HashMap   │ Aurora PG (reader)      │"
echo "  │ API                 │ Spring Boot         │ API Gateway (IAM auth)  │"
echo "  │ Deployment          │ EKS (containers)    │ Serverless (Lambda)     │"
echo "  │ Scaling             │ Manual (pods)       │ Automatic (ACUs)        │"
echo "  │ Cost Model          │ Always-on           │ Per-ACU-hour + requests │"
echo "  └─────────────────────┴─────────────────────┴─────────────────────────┘"
echo ""
explain "Same pattern (CQRS/ES), different implementation."
explain "Aurora approach: SQL event store + SQL read model, serverless compute."
echo ""
printf "%b\n" "  ${GREEN}Demo complete!${RESET}"
echo ""
