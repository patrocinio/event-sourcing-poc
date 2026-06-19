#!/bin/bash
###############################################################################
# Axon Framework CQRS/Event Sourcing — Live Demo Script
#
# This script walks through the key capabilities of the Axon Framework PoC:
#   1. CQRS (Command Query Responsibility Segregation)
#   2. Event Sourcing — state rebuilt from immutable event stream
#   3. Domain-driven aggregate lifecycle with business rule enforcement
#   4. Decoupled projections (read models) built from events
#
# Prerequisites:
#   - The app is running on EKS (or locally)
#   - curl and jq installed
#
# Usage:
#   chmod +x demo.sh
#   ./demo.sh [BASE_URL]
#
# If no BASE_URL is provided, defaults to the NLB endpoint.
###############################################################################

set -e

BASE="${1:-http://ab515f97030094f14898cb6d4f0cc4bc-19e4414d77b31d76.elb.us-east-1.amazonaws.com}"
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
header "AXON FRAMEWORK PoC — CQRS & EVENT SOURCING DEMO"
###############################################################################

echo ""
echo "  This demo showcases a Loan Originations system built with:"
echo ""
echo "    • Axon Framework — CQRS + Event Sourcing library"
echo "    • Axon Server    — Dedicated event store & message router"
echo "    • Spring Boot    — REST API layer"
echo ""
echo "  Architecture:"
echo ""
echo "    ┌─────────────┐    Command     ┌──────────────┐    Events    ┌─────────────┐"
echo "    │  REST API   │───────────────▶│  Aggregate   │────────────▶│ Axon Server │"
echo "    │ (Controller)│                │ (Domain Logic)│             │ (Event Store)│"
echo "    └─────────────┘                └──────────────┘             └──────┬──────┘"
echo "          ▲                                                            │"
echo "          │  Query                                                     │ Events"
echo "          │                                                            ▼"
echo "    ┌─────────────┐                                            ┌──────────────┐"
echo "    │  Projection │◀───────────────────────────────────────────│  Projection  │"
echo "    │ (Read Model) │                                           │(Event Handler)│"
echo "    └─────────────┘                                            └──────────────┘"
echo ""
echo -e "  Endpoint: ${BOLD}${BASE}${RESET}"

pause

###############################################################################
header "PART 1: COMMAND SIDE — Submitting a Loan Application"
###############################################################################

explain "A command is an intent to change state. It goes to the Aggregate,"
explain "which validates business rules and emits an immutable Event."
echo ""
step "Sending SubmitLoanApplicationCommand..."
echo ""
echo "  curl -X POST ${BASE}/api/loans"
echo '  Body: {"applicantName":"Maria Garcia","requestedAmount":120000,"purpose":"Home Purchase"}'
echo ""

RESULT=$(curl -s -X POST "${BASE}/api/loans" \
  -H "Content-Type: application/json" \
  -d '{"applicantName":"Maria Garcia","requestedAmount":120000,"purpose":"Home Purchase"}')

echo "  Response:"
echo "  $RESULT" | jq '.' 2>/dev/null || echo "  $RESULT"

LOAN_ID=$(echo "$RESULT" | jq -r '.loanId' 2>/dev/null || echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['loanId'])" 2>/dev/null)

echo ""
explain "Behind the scenes:"
explain "  1. Controller received POST → created SubmitLoanApplicationCommand"
explain "  2. Axon routed command to LoanAggregate constructor"
explain "  3. Aggregate validated: amount > 0 ✓"
explain "  4. Aggregate emitted: LoanApplicationSubmittedEvent"
explain "  5. Axon Server stored the event permanently (append-only log)"
explain "  6. Projection received event → updated read model"

pause

###############################################################################
header "PART 2: QUERY SIDE — Reading from the Projection (Read Model)"
###############################################################################

explain "Queries never touch the Aggregate. They read from a separate projection"
explain "that was built asynchronously from the event stream."
echo ""
step "Querying loan by ID (from Projection, NOT from Aggregate)..."
echo ""

curl -s "${BASE}/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null || curl -s "${BASE}/api/loans/${LOAN_ID}"

echo ""
explain "Key CQRS insight: The write model (Aggregate) and read model (Projection)"
explain "are completely independent. You can scale, optimize, and deploy them separately."

pause

###############################################################################
header "PART 3: DOMAIN LOGIC — Business Rule Enforcement in Aggregate"
###############################################################################

explain "The Aggregate enforces invariants. Only valid state transitions are allowed."
explain "Let's try an INVALID transition: disbursing a loan that hasn't been approved."
echo ""
step "Attempting to disburse a SUBMITTED loan (should fail)..."
echo ""

INVALID_RESULT=$(curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/disburse" \
  -H "Content-Type: application/json" \
  -d '{"disbursementAccount":"ACCT-999"}')

echo "  Response:"
echo "  $INVALID_RESULT" | jq '.' 2>/dev/null || echo "  $INVALID_RESULT"

echo ""
explain "The Aggregate enforced: 'Can only disburse an APPROVED loan'"
explain "This is the Aggregate's job — protect business invariants regardless"
explain "of which channel the command came from (API, batch, event-driven)."

pause

###############################################################################
header "PART 4: STATE MACHINE — Walking Through the Loan Lifecycle"
###############################################################################

explain "Loan lifecycle: SUBMITTED → APPROVED → DISBURSED"
explain "Each transition emits an event that is persisted forever."
echo ""

# Approve
step "Step 1: Approving the loan..."
echo ""
curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/approve" \
  -H "Content-Type: application/json" \
  -d '{"approvedAmount":115000,"approvedBy":"Sarah Chen (VP Lending)"}' | jq '.' 2>/dev/null

echo ""
explain "Event emitted: LoanApprovedEvent (approvedAmount=115000, approvedBy=Sarah Chen)"

pause

# Disburse
step "Step 2: Disbursing the approved loan..."
echo ""
curl -s -X POST "${BASE}/api/loans/${LOAN_ID}/disburse" \
  -H "Content-Type: application/json" \
  -d '{"disbursementAccount":"ACH-0012345678"}' | jq '.' 2>/dev/null

echo ""
explain "Event emitted: LoanDisbursedEvent (account=ACH-0012345678)"

pause

# Show final state
step "Step 3: Final state (built from ALL events replayed)..."
echo ""
curl -s "${BASE}/api/loans/${LOAN_ID}" | jq '.' 2>/dev/null

echo ""
explain "This view was constructed by the Projection replaying 3 events:"
explain "  Event 1: LoanApplicationSubmittedEvent → status=SUBMITTED"
explain "  Event 2: LoanApprovedEvent             → status=APPROVED"
explain "  Event 3: LoanDisbursedEvent            → status=DISBURSED"

pause

###############################################################################
header "PART 5: EVENT SOURCING — Why It Matters"
###############################################################################

explain "Traditional approach: UPDATE loans SET status='DISBURSED' WHERE id=X"
explain "  → Previous states are LOST. You only have current state."
echo ""
explain "Event Sourcing approach: Store every event that ever happened."
explain "  → Complete audit trail. Rebuild state to ANY point in time."
explain "  → Replay events to build new projections without downtime."
echo ""
step "Let's submit a second loan and reject it to show a different path..."
echo ""

RESULT2=$(curl -s -X POST "${BASE}/api/loans" \
  -H "Content-Type: application/json" \
  -d '{"applicantName":"James Wilson","requestedAmount":500000,"purpose":"Speculative Investment"}')

LOAN_ID2=$(echo "$RESULT2" | jq -r '.loanId' 2>/dev/null || echo "$RESULT2" | python3 -c "import sys,json; print(json.load(sys.stdin)['loanId'])" 2>/dev/null)
echo "  Created loan: $LOAN_ID2"

curl -s -X POST "${BASE}/api/loans/${LOAN_ID2}/reject" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Amount exceeds risk threshold for speculative purposes","rejectedBy":"Risk Engine (automated)"}' | jq '.' 2>/dev/null

echo ""
explain "This loan followed a different path: SUBMITTED → REJECTED"
explain "Both paths (approve+disburse and reject) coexist in the event store."

pause

###############################################################################
header "PART 6: QUERY BY STATUS — Multiple Projections from Same Events"
###############################################################################

explain "Projections can slice data any way you want. Same events, different views."
echo ""
step "All loans:"
curl -s "${BASE}/api/loans" | jq '.' 2>/dev/null
echo ""

step "Only DISBURSED loans:"
curl -s "${BASE}/api/loans/status/DISBURSED" | jq '.' 2>/dev/null
echo ""

step "Only REJECTED loans:"
curl -s "${BASE}/api/loans/status/REJECTED" | jq '.' 2>/dev/null

echo ""
explain "In production, you could add more projections WITHOUT changing the command side:"
explain "  • Monthly loan volume dashboard (Elasticsearch)"
explain "  • Risk scoring model (ML pipeline consuming events)"
explain "  • Regulatory reporting (separate audit database)"
explain "  • Real-time notifications (WebSocket projection)"

pause

###############################################################################
header "PART 7: AXON SERVER — The Event Store & Message Router"
###############################################################################

explain "Axon Server provides:"
explain "  • Append-only event store (like a database commit log, but for business events)"
explain "  • Command routing (finds which aggregate instance handles a command)"
explain "  • Event distribution (fan-out to all subscribed projections)"
explain "  • Event replay (rebuild projections from scratch)"
echo ""
explain "Access Axon Server dashboard:"
explain "  kubectl port-forward svc/axon-server-client 8024:8024 -n axon-poc"
explain "  Then open: http://localhost:8024"
echo ""
explain "In the dashboard you can see:"
explain "  • All events stored for each aggregate"
explain "  • Connected applications"
explain "  • Command and query metrics"

pause

###############################################################################
header "SUMMARY — What Axon Framework Gives Us"
###############################################################################

echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  CQRS Benefits                                                  │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  ✓ Independent scaling of reads vs writes                       │"
echo "  │  ✓ Optimized read models for each use case                      │"
echo "  │  ✓ Clean separation of concerns                                 │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Event Sourcing Benefits                                        │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  ✓ Complete audit trail (regulatory compliance)                  │"
echo "  │  ✓ Temporal queries — state at any point in time                 │"
echo "  │  ✓ Add new projections retroactively (replay events)             │"
echo "  │  ✓ Debug production issues by replaying exact event sequence     │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Axon Framework + Server Benefits                               │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  ✓ Built-in event store (no custom infrastructure)               │"
echo "  │  ✓ Automatic command routing to correct aggregate                │"
echo "  │  ✓ Event replay for projection rebuilds                          │"
echo "  │  ✓ Location transparency — components can run anywhere           │"
echo "  │  ✓ Ready for microservice decomposition                          │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
echo -e "  ${GREEN}Demo complete!${RESET}"
echo ""
