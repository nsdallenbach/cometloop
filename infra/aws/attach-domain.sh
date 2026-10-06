#!/usr/bin/env bash
# Attach the custom-domain certificate to the HTTPS listener that Express
# Mode created, and let the listener's host-header rule accept the hostname.
# Run after `terraform apply` and after the ACM certificate shows ISSUED
# (the validation CNAME from `terraform output custom_domain_dns_records`
# must exist in Cloudflare first). Idempotent: re-running is harmless.
#
#   AWS_PROFILE=cometloop ./attach-domain.sh            # uses terraform output
#   AWS_PROFILE=cometloop ./attach-domain.sh staging.cometloop.ai arn:aws:acm:...
#
# These are direct ELB API calls on resources ECS manages for the Express
# service. Express Mode does not revert them (express-service-advanced-
# customization), but an Express update that changes the listener would
# need this re-run — which is why it is a script and not a one-off.
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="${1:-$(terraform output -raw custom_domain)}"
CERT_ARN="${2:-$(terraform output -raw certificate_arn)}"
SERVICE_ARN="$(terraform output -raw service_arn)"
REGION="$(terraform output -raw region)"
ENDPOINT="$(terraform output -json service_endpoints | python -c 'import json,sys; print(json.load(sys.stdin)[0]["endpoint"])' | sed -E 's#^https?://##')"

status="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" --query Certificate.Status --output text)"
if [ "$status" != "ISSUED" ]; then
  echo "certificate is $status, not ISSUED — create the ACM validation CNAME in Cloudflare and wait" >&2
  exit 1
fi

# The Express endpoint is an alias straight to the load balancer's IPs, so
# the load balancer cannot be matched by DNS name. The service revision
# names the exact listener rule ECS created; the listener and the load
# balancer are its parents (ARN layout: …:listener-rule/app/<lb>/<lb-id>/<listener-id>/<rule-id>).
REVISION_ARN="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --region "$REGION" \
  --query 'service.activeConfigurations[0].serviceRevisionArn' --output text)"
RULE_ARN="$(aws ecs describe-service-revisions --service-revision-arns "$REVISION_ARN" --region "$REGION" \
  --query 'serviceRevisions[0].resolvedConfiguration.loadBalancers[0].productionListenerRule' --output text)"
if [ -z "$RULE_ARN" ] || [ "$RULE_ARN" = "None" ]; then
  echo "the service revision names no listener rule — is this an Express Mode service with a load balancer?" >&2
  exit 1
fi
LISTENER_ARN="$(printf '%s' "$RULE_ARN" | sed -E 's#:listener-rule/(app/[^/]+/[^/]+/[^/]+)/[^/]+$#:listener/\1#')"
LB_ARN="$(printf '%s' "$RULE_ARN" | sed -E 's#:listener-rule/(app/[^/]+/[^/]+)/[^/]+/[^/]+$#:loadbalancer/\1#')"

echo "load balancer: $LB_ARN"
echo "https listener: $LISTENER_ARN"
echo "listener rule:  $RULE_ARN"

# 1. The certificate on the listener (SNI picks it for the hostname).
aws elbv2 add-listener-certificates --listener-arn "$LISTENER_ARN" --region "$REGION" \
  --certificates "CertificateArn=$CERT_ARN" >/dev/null
echo "certificate attached"

# 2. The rule Express created forwards only its own host; add ours as an OR value.
RULE_JSON="$(aws elbv2 describe-rules --rule-arns "$RULE_ARN" --region "$REGION" --query 'Rules[0]' --output json)"
HOSTS="$(printf '%s' "$RULE_JSON" | python -c '
import json,sys
r=json.load(sys.stdin)
vals=[]
for c in r.get("Conditions",[]):
    if c.get("Field")=="host-header":
        vals += c.get("HostHeaderConfig",{}).get("Values") or c.get("Values") or []
print(json.dumps(sorted(set(vals + [sys.argv[1]]))))' "$DOMAIN")"
if [ "$HOSTS" = "[\"$DOMAIN\"]" ]; then
  # No host condition existed: the rule forwarded every host already, so
  # adding one would *restrict* it. Leave the rule alone.
  echo "the listener rule has no host-header condition; nothing to add"
else
  aws elbv2 modify-rule --rule-arn "$RULE_ARN" --region "$REGION" >/dev/null \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":$HOSTS}}]"
  echo "host rule now accepts: $HOSTS"
fi

echo
echo "Now create the CNAME in Cloudflare:  $DOMAIN  ->  $ENDPOINT"
echo "then: curl -sS https://$DOMAIN/healthz"
