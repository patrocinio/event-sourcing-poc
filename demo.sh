#!/bin/bash
###############################################################################
# AWS-Native CQRS/Event Sourcing — Live Demo Script (Multi-Region)
#
# This demonstrates CQRS/Event Sourcing with native AWS services in an
# active-active multi-region deployment (us-east-1 + us-west-2):
#   - API Gateway (REST API) per region
#   - Lambda (TypeScript) for compute
#   - DynamoDB Global Tables (event store with cross-region replication)
#   - Kinesis Data Streams (event distribution)
#   - ElastiCache Redis Multi-AZ (read model / projection)
#
# Usage:
#   ./demo.sh
#   (auto-discovers endpoints from CloudFormation stacks)
###############################################################################

set -e

# Auto-discover regional endpoints
PRIMARY="${PRIMARY_URL:-$(aws cloudformation describe-stacks --stack-name LoanOriginationsPrimary --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null)}"
SECONDARY="${SECONDARY_URL:-$(aws cloudformation describe-stacks --stack-name LoanOriginationsSecondary --region us-west-2 --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null)}"

PRIMARY="${PRIMARY%/}"
SECONDARY="${SECONDARY%/}"

if [ -z "$PRIMARY" ] || [ "$PRIMARY" = "None" ]; then
  echo "  ERROR: Could not determine Primary API URL (us-east-1)."
  echo "  Set PRIMARY_URL env var or deploy LoanOriginationsPrimary stack."
  exit 1
fi
if [ -z "$SECONDARY" ] || [ "$SECONDARY" = "None" ]; then
  echo "  WARNING: Secondary region (us-west-2) not available. Cross-region tests will be skipped."
  SECONDARY=""
fi

# Use PRIMARY as default BASE for single-region parts
BASE="$PRIMARY"

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
echo "    • API Gateway     — REST API endpoints (per region)"
echo "    • Lambda          — Command & Query handlers (TypeScript)"
echo "    • DynamoDB        — Global Tables Event Store (multi-region)"
echo "    • Kinesis Streams — Event distribution"
echo "    • ElastiCache     — Redis Multi-AZ read model (per region)"
echo ""
echo "  Multi-Region Active-Active Architecture:"
echo ""
echo "                    Route53 (Latency-Based Routing)"
echo "                         │"
echo "            ┌────────────┼────────────┐"
echo "            ▼                         ▼"
echo "    ┌──────────────┐          ┌──────────────┐"
echo "    │  us-east-1   │          │  us-west-2   │"
echo "    │  API Gateway │          │  API Gateway │"
echo "    │  Lambda      │          │  Lambda      │"
echo "    │  Redis (3AZ) │          │  Redis (3AZ) │"
echo "    └──────┬───────┘          └──────┬───────┘"
echo "           │                         │"
echo "           └──── DynamoDB Global ────┘"
echo "                  Tables (sync)"
echo ""
echo -e "  ${BOLD}Primary (us-east-1):${RESET}   ${PRIMARY}"
if [ -n "$SECONDARY" ]; then
echo -e "  ${BOLD}Secondary (us-west-2):${RESET}  ${SECONDARY}"
fi

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
header "PART 7: CROSS-REGION ACTIVE-ACTIVE — DynamoDB Global Tables"
###############################################################################

if [ -z "$SECONDARY" ]; then
  explain "Secondary region not deployed. Skipping cross-region test."
else
  explain "This is the key production-readiness feature: ACTIVE-ACTIVE multi-region."
  explain "Both us-east-1 and us-west-2 can serve reads AND writes simultaneously."
  explain "DynamoDB Global Tables replicate events bi-directionally (<1s latency)."
  echo ""
  echo -e "  ${BOLD}Primary (us-east-1):${RESET}   ${PRIMARY}"
  echo -e "  ${BOLD}Secondary (us-west-2):${RESET}  ${SECONDARY}"
  echo ""

  step "Step 1: Submit a loan on PRIMARY (us-east-1)..."
  echo ""
  CROSS_RESULT=$(curl -s -X POST "${PRIMARY}/api/loans" \
    -H "Content-Type: application/json" \
    -d '{"applicantName":"Cross-Region Test","requestedAmount":200000,"purpose":"Multi-Region Active-Active Demo"}')
  echo "  $CROSS_RESULT" | jq '.' 2>/dev/null
  CROSS_LOAN_ID=$(echo "$CROSS_RESULT" | jq -r '.loanId' 2>/dev/null)

  pause

  step "Step 2: Approve the loan on SECONDARY (us-west-2)..."
  explain "(Events replicated via DynamoDB Global Tables in <1 second)"
  echo ""
  sleep 3  # Allow replication
  APPROVE_RESULT=$(curl -s -X POST "${SECONDARY}/api/loans/${CROSS_LOAN_ID}/approve" \
    -H "Content-Type: application/json" \
    -d '{"approvedAmount":195000,"approvedBy":"West Coast Manager"}')
  echo "  $APPROVE_RESULT" | jq '.' 2>/dev/null

  echo ""
  explain "The Secondary region's Command Lambda:"
  explain "  1. Queried DynamoDB (local us-west-2 replica) for this loan's events"
  explain "  2. Found the LoanApplicationSubmittedEvent (replicated from us-east-1)"
  explain "  3. Validated: status=SUBMITTED, approve is valid"
  explain "  4. Wrote LoanApprovedEvent to DynamoDB (us-west-2 replica)"
  explain "  5. That event replicates back to us-east-1 automatically"

  pause

  step "Step 3: Disburse on PRIMARY (us-east-1) — reading approval from us-west-2..."
  echo ""
  sleep 3  # Allow replication back
  DISBURSE_RESULT=$(curl -s -X POST "${PRIMARY}/api/loans/${CROSS_LOAN_ID}/disburse" \
    -H "Content-Type: application/json" \
    -d '{"disbursementAccount":"ACH-CROSS-REGION-001"}')
  echo "  $DISBURSE_RESULT" | jq '.' 2>/dev/null

  echo ""
  explain "Primary region saw the approval event (replicated from us-west-2)"
  explain "and successfully processed the disbursement."

  pause

  step "Step 4: Verify final state from both regions..."
  echo ""
  sleep 3
  echo -e "  ${BOLD}From PRIMARY (us-east-1):${RESET}"
  curl -s "${PRIMARY}/api/loans/${CROSS_LOAN_ID}" | jq '.status, .approvedBy' 2>/dev/null
  echo ""
  echo -e "  ${BOLD}From SECONDARY (us-west-2):${RESET}"
  curl -s "${SECONDARY}/api/loans/${CROSS_LOAN_ID}" | jq '.status, .approvedBy' 2>/dev/null

  echo ""
  explain "Both regions show DISBURSED — perfect consistency via Global Tables."
  echo ""
  echo "  Timeline of this loan across regions:"
  echo "    ┌────────────────────────────────────────────────────────────┐"
  echo "    │  us-east-1: Submit ──────────────────────── Disburse      │"
  echo "    │               │                              ▲             │"
  echo "    │               │   DynamoDB Global Tables     │             │"
  echo "    │               ▼   (bi-directional sync)      │             │"
  echo "    │  us-west-2:        ──────── Approve ─────────             │"
  echo "    └────────────────────────────────────────────────────────────┘"
fi

pause

###############################################################################
header "PART 8: AWS SERVICES vs AXON FRAMEWORK — Comparison"
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
