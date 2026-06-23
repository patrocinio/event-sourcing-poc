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
#   ./demo.sh [LOAN_APP_URL]
#
# Or set environment variables:
#   export LOAN_APP_URL=http://<loan-app-nlb>
#   ./demo.sh
#
# To get the loan app URL from a running cluster:
#   kubectl get svc loan-originations-poc -n axon-poc -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
#
# For the Axon Server dashboard (internal only, requires port-forward):
#   kubectl port-forward svc/axon-server-client 8024:8024 -n axon-poc
#   Then open: http://localhost:8024
###############################################################################

set -e

BASE="${1:-${LOAN_APP_URL:-http://LOAN-APP-NLB-URL}}"
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
header "PART 7: AXON SERVER DASHBOARD — Seeing the Event Store in Action"
###############################################################################

AXON_DASHBOARD="http://localhost:8024"
AXON_TOKEN="axon-poc-access-token-2024"

explain "Axon Server provides:"
explain "  • Append-only event store (like a database commit log, but for business events)"
explain "  • Command routing (finds which aggregate instance handles a command)"
explain "  • Event distribution (fan-out to all subscribed projections)"
explain "  • Event replay (rebuild projections from scratch)"
echo ""
explain "The dashboard is internal-only (not publicly exposed) for security."
explain "Starting port-forward to access it locally..."
echo ""
step "Starting kubectl port-forward in background..."
kubectl port-forward svc/axon-server-client 8024:8024 -n axon-poc &>/dev/null &
PF_PID=$!
sleep 3
echo "  Port-forward started (PID: ${PF_PID})"
echo ""
echo -e "  ${BOLD}Dashboard URL:${RESET} ${AXON_DASHBOARD}"
echo ""
step "Opening Axon Server Dashboard in browser..."
open "${AXON_DASHBOARD}" 2>/dev/null || echo "  Open the URL above in your browser"

pause

###############################################################################
header "PART 7a: DASHBOARD WALKTHROUGH — Login & Overview"
###############################################################################

explain "When the dashboard loads, you'll see the OVERVIEW page:"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Overview Page                                                  │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  • Node name: axon-server-0                                     │"
echo "  │  • Context: 'default' — our event store partition                │"
echo "  │  • Connected apps: axon-poc-loan-originations (2 instances)      │"
echo "  │  • Event count: shows total events stored                        │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
explain "Key observation: The app connects TWICE (2 pods) but Axon Server"
explain "routes commands to the correct aggregate instance automatically."
echo ""
explain "Security note: The dashboard is only accessible via port-forward"
explain "(kubectl). It is NOT exposed to the public internet."

pause

###############################################################################
header "PART 7b: DASHBOARD WALKTHROUGH — Search Events"
###############################################################################

explain "Click 'Search' in the left sidebar to browse the event store."
echo ""
echo "  Steps:"
echo "    1. Select context: 'default'"
echo "    2. Click 'Search' with no filters → see ALL events"
echo "    3. Notice events are ordered by global sequence number"
echo ""
echo "  You'll see events like:"
echo "    ┌────┬──────────────────────────────────┬─────────────────────┐"
echo "    │ #  │ Event Type                       │ Aggregate ID        │"
echo "    ├────┼──────────────────────────────────┼─────────────────────┤"
echo "    │ 0  │ LoanApplicationSubmittedEvent     │ ${LOAN_ID:0:8}...   │"
echo "    │ 1  │ LoanApprovedEvent                 │ ${LOAN_ID:0:8}...   │"
echo "    │ 2  │ LoanDisbursedEvent                │ ${LOAN_ID:0:8}...   │"
echo "    │ 3  │ LoanApplicationSubmittedEvent     │ ${LOAN_ID2:0:8}...  │"
echo "    │ 4  │ LoanRejectedEvent                 │ ${LOAN_ID2:0:8}...  │"
echo "    └────┴──────────────────────────────────┴─────────────────────┘"
echo ""
explain "Click any event to expand its JSON payload — you'll see the full"
explain "immutable fact: applicantName, requestedAmount, timestamps, etc."
echo ""
explain "KEY INSIGHT: These events are the source of truth. The read model"
explain "(projection) is derived FROM these events. Delete the projection?"
explain "No problem — replay these events and rebuild it."

pause

###############################################################################
header "PART 7c: DASHBOARD WALKTHROUGH — Filter by Aggregate"
###############################################################################

explain "Now let's look at a single loan's complete history:"
echo ""
echo "  Steps:"
echo "    1. In the Search page, paste this Aggregate ID:"
echo -e "       ${BOLD}${LOAN_ID}${RESET}"
echo "    2. Click 'Search'"
echo ""
echo "  Result — the complete lifecycle of Maria Garcia's loan:"
echo "    Event 0: LoanApplicationSubmittedEvent (amount=120000)"
echo "    Event 1: LoanApprovedEvent (approved=115000, by Sarah Chen)"
echo "    Event 2: LoanDisbursedEvent (account=ACH-0012345678)"
echo ""
explain "This IS the aggregate's state. There is no loans table. The aggregate"
explain "is reconstructed by replaying these 3 events in order."
explain "This is event sourcing — state = f(events)."

pause

###############################################################################
header "PART 7d: DASHBOARD WALKTHROUGH — Commands & Queries"
###############################################################################

explain "Click 'Commands' in the sidebar:"
echo ""
echo "  You'll see registered command handlers:"
echo "    • SubmitLoanApplicationCommand  → LoanAggregate (constructor)"
echo "    • ApproveLoanCommand            → LoanAggregate.handle()"
echo "    • RejectLoanCommand             → LoanAggregate.handle()"
echo "    • DisburseLoanCommand           → LoanAggregate.handle()"
echo ""
explain "Click 'Queries' in the sidebar:"
echo ""
echo "  You'll see registered query handlers:"
echo "    • FindAllLoansQuery        → LoanProjection"
echo "    • FindLoanByIdQuery        → LoanProjection"
echo "    • FindLoansByStatusQuery   → LoanProjection"
echo ""
explain "Notice: Commands go to AGGREGATES, Queries go to PROJECTIONS."
explain "Axon Server handles all the routing — your code just declares handlers."

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

# Cleanup port-forward
if [ -n "${PF_PID:-}" ] && kill -0 "$PF_PID" 2>/dev/null; then
  kill "$PF_PID" 2>/dev/null
  echo "  (Port-forward stopped)"
fi
