#!/bin/bash
###############################################################################
# AWS-Native CQRS/Event Sourcing — Live Demo Script
#
# This demonstrates the same Loan Originations patterns as the Axon PoC,
# but implemented entirely with native AWS services:
#   - API Gateway (REST API)
#   - Lambda (TypeScript) for compute
#   - DynamoDB (Event Store)
#   - Kinesis Data Streams (event distribution)
#   - ElastiCache Redis (read model / projection)
#
# Usage:
#   export API_URL=$(aws cloudformation describe-stacks --stack-name LoanOriginationsApi \
#     --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
#   ./demo.sh
###############################################################################

set -e

BASE="${API_URL:-${1:-$(aws cloudformation describe-stacks --stack-name LoanOriginationsApi --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null)}}"
if [ -z "$BASE" ] || [ "$BASE" = "None" ]; then
  echo "  ERROR: Could not determine API URL."
  echo "  Either set API_URL env var, pass as argument, or ensure LoanOriginationsApi stack is deployed."
  exit 1
fi
# Remove trailing slash
BASE="${BASE%/}"

BOLD="\033[1m"
GREEN="\033[1;32m"
CYAN="\033[1;36m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
RESET="\033[0m"

pause() {
  echo ""
  read -rp "  ▶ Press ENTER to continue..." _
  echo ""
}

header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  $1${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

step() {
  echo -e "  ${GREEN}→${RESET} $1"
}

explain() {
  echo -e "  ${YELLOW}ℹ${RESET} $1"
}

###############################################################################
header "AWS-NATIVE CQRS & EVENT SOURCING DEMO"
###############################################################################

echo ""
echo "  This demo showcases a Loan Originations system built with:"
echo ""
echo "    • API Gateway     — REST API endpoints"
echo "    • Lambda          — Command & Query handlers (TypeScript)"
echo "    • DynamoDB        — Event Store (append-only)"
echo "    • Kinesis Streams — Event distribution"
echo "    • ElastiCache     — Redis read model (projection)"
echo ""
echo "  Architecture (same CQRS/ES pattern, pure AWS services):"
echo ""
echo "    ┌──────────────┐     ┌────────────┐     ┌──────────────┐"
echo "    │  API Gateway │────▶│  Command   │────▶│  DynamoDB    │"
echo "    │  (REST API)  │     │  Lambda    │     │ (Event Store)│"
echo "    └──────────────┘     └────────────┘     └──────┬───────┘"
echo "          │                                        │"
echo "          │                              DynamoDB Streams"
echo "          │                                        │"
echo "          │                                        ▼"
echo "          │             ┌────────────┐    ┌────────────────┐"
echo "          └────────────▶│   Query    │    │   Projector    │"
echo "                        │   Lambda   │    │    Lambda      │"
echo "                        └─────┬──────┘    └───────┬────────┘"
echo "                              │                    │"
echo "                              ▼                    ▼"
echo "                        ┌──────────────────────────────┐"
echo "                        │   ElastiCache (Redis)        │"
echo "                        │   Read Model / Projection    │"
echo "                        └──────────────────────────────┘"
echo ""
echo -e "  Endpoint: ${BOLD}${BASE}${RESET}"

pause

###############################################################################
header "PART 1: COMMAND SIDE — Submit Loan Application"
###############################################################################

explain "Commands go to the Command Lambda, which:"
explain "  1. Replays events from DynamoDB to rebuild aggregate state"
explain "  2. Validates business rules"
explain "  3. Persists new event to DynamoDB (optimistic concurrency)"
explain "  4. Publishes event to Kinesis for downstream consumers"
echo ""
step "Sending SubmitLoan command..."
echo ""

RESULT=$(curl -s -X POST "${BASE}/api/loans" \
  -H "Content-Type: application/json" \
  -d '{"applicantName":"Maria Garcia","requestedAmount":120000,"purpose":"Home Purchase"}')

echo "  Response:"
echo "  $RESULT" | jq '.' 2>/dev/null || echo "  $RESULT"

LOAN_ID=$(echo "$RESULT" | jq -r '.loanId' 2>/dev/null)

echo ""
explain "Behind the scenes:"
explain "  1. API Gateway → Command Lambda"
explain "  2. Lambda wrote LoanApplicationSubmittedEvent to DynamoDB"
explain "  3. DynamoDB Streams triggered Projector Lambda"
explain "  4. Projector updated Redis read model"
explain "  5. Event also published to Kinesis (for other consumers)"

pause

###############################################################################
header "PART 2: QUERY SIDE — Read from Projection"
###############################################################################

explain "Queries go to the Query Lambda, which reads from Redis (NOT DynamoDB)."
explain "This is CQRS: write path and read path are completely separate."
echo ""
step "Querying loan by ID..."
echo ""

curl -s "${BASE}/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

echo ""
explain "The Query Lambda never touches the Event Store (DynamoDB)."
explain "It reads from Redis — the pre-computed read model."

pause

###############################################################################
header "PART 3: BUSINESS RULES — State Machine Enforcement"
###############################################################################

explain "The Command Lambda enforces invariants by replaying events first."
echo ""
step "Attempting invalid transition: disburse a SUBMITTED loan..."
echo ""

curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/disburse" \
  -H "Content-Type: application/json" \
  -d '{"disbursementAccount":"ACCT-999"}' | jq '.' 2>/dev/null

echo ""
explain "HTTP 409: 'Can only disburse an APPROVED loan'"
explain "The Lambda replayed events → state=SUBMITTED → rejected command."

pause

###############################################################################
header "PART 4: FULL LIFECYCLE — Submit → Approve → Disburse"
###############################################################################

step "Approving..."
curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/approve" \
  -H "Content-Type: application/json" \
  -d '{"approvedAmount":115000,"approvedBy":"Sarah Chen (VP Lending)"}' | jq '.' 2>/dev/null
echo ""

step "Disbursing..."
curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/disburse" \
  -H "Content-Type: application/json" \
  -d '{"disbursementAccount":"ACH-0012345678"}' | jq '.' 2>/dev/null
echo ""

step "Final state from projection:"
sleep 2  # Allow projector Lambda to update Redis
curl -s "${BASE}/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

echo ""
explain "DynamoDB now has 3 events for this aggregate:"
explain "  v1: LoanApplicationSubmittedEvent"
explain "  v2: LoanApprovedEvent"
explain "  v3: LoanDisbursedEvent"

pause

###############################################################################
header "PART 5: EVENT SOURCING — Different Paths Coexist"
###############################################################################

step "Submitting a second loan and rejecting it..."
echo ""

RESULT2=$(curl -s -X POST "${BASE}/api/loans" \
  -H "Content-Type: application/json" \
  -d '{"applicantName":"James Wilson","requestedAmount":500000,"purpose":"Speculative Investment"}')

LOAN_ID2=$(echo "$RESULT2" | jq -r '.loanId' 2>/dev/null)

curl -s -X POST "${BASE}/api/loans/${LOAN_ID2}/reject" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Amount exceeds risk threshold","rejectedBy":"Risk Engine (automated)"}' | jq '.' 2>/dev/null

echo ""
explain "Both paths stored in DynamoDB event store permanently."
explain "SUBMITTED→APPROVED→DISBURSED and SUBMITTED→REJECTED coexist."

pause

###############################################################################
header "PART 6: QUERY BY STATUS"
###############################################################################

step "All loans:"
curl -s "${BASE}/api/loans" | jq '.' 2>/dev/null
echo ""

step "DISBURSED only:"
curl -s "${BASE}/api/loans/status/DISBURSED" | jq '.' 2>/dev/null
echo ""

step "REJECTED only:"
curl -s "${BASE}/api/loans/status/REJECTED" | jq '.' 2>/dev/null

pause

###############################################################################
header "PART 7: AWS SERVICES vs AXON FRAMEWORK — Comparison"
###############################################################################

echo ""
echo "  ┌─────────────────────┬─────────────────────┬─────────────────────┐"
echo "  │ Concern             │ Axon Framework      │ AWS Native          │"
echo "  ├─────────────────────┼─────────────────────┼─────────────────────┤"
echo "  │ Event Store         │ Axon Server         │ DynamoDB            │"
echo "  │ Event Routing       │ Axon Server         │ Kinesis Streams     │"
echo "  │ Command Handling    │ @CommandHandler     │ Lambda function     │"
echo "  │ Query Handling      │ @QueryHandler       │ Lambda function     │"
echo "  │ Projections         │ @EventHandler       │ DynamoDB Streams    │"
echo "  │ Read Model          │ In-memory HashMap   │ ElastiCache Redis   │"
echo "  │ API                 │ Spring Boot         │ API Gateway         │"
echo "  │ Deployment          │ EKS (containers)    │ Serverless (Lambda) │"
echo "  │ Scaling             │ Manual (pods)       │ Automatic           │"
echo "  │ Cost Model          │ Always-on           │ Pay-per-request     │"
echo "  └─────────────────────┴─────────────────────┴─────────────────────┘"
echo ""
explain "Same pattern (CQRS/ES), different implementation."
explain "AWS-native approach: no servers, auto-scaling, pay-per-use."
echo ""
echo -e "  ${GREEN}Demo complete!${RESET}"
echo ""
