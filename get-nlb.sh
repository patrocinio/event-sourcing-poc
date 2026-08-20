#!/bin/bash
###############################################################################
# Retrieve the Network Load Balancer hostname for the Loan Originations app
#
# Usage:
#   chmod +x get-nlb.sh
#   ./get-nlb.sh
#
# Prerequisites:
#   - kubectl configured with access to the EKS cluster
#   - aws CLI configured (if you need to update kubeconfig first)
#
# To update kubeconfig:
#   aws eks update-kubeconfig --name axon-poc-cluster --region us-east-1
###############################################################################

set -e

NAMESPACE="axon-poc"
SERVICE_NAME="loan-originations-poc"

echo "Retrieving NLB hostname for service ${SERVICE_NAME} in namespace ${NAMESPACE}..."
echo ""

NLB_HOSTNAME=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)

if [ -z "$NLB_HOSTNAME" ]; then
  echo "ERROR: Could not retrieve NLB hostname."
  echo ""
  echo "Possible causes:"
  echo "  - Service does not exist yet (run the deploy pipeline first)"
  echo "  - LoadBalancer is still provisioning (wait a few minutes)"
  echo "  - kubectl is not configured for the correct cluster"
  echo ""
  echo "Service status:"
  kubectl get svc -n "$NAMESPACE" 2>/dev/null || echo "  (namespace ${NAMESPACE} not found)"
  exit 1
fi

echo "NLB Hostname:"
echo "  ${NLB_HOSTNAME}"
echo ""
echo "App URL:"
echo "  http://${NLB_HOSTNAME}"
echo ""
echo "To run the demo:"
echo "  ./demo.sh http://${NLB_HOSTNAME}"
