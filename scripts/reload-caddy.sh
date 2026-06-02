#!/usr/bin/env bash
# certbot deploy-hook: reload Caddy in place after the wildcard cert renews, so
# the fresh cert is served with no restart/downtime.
#
# Wire it into your existing certbot renewal, e.g.:
#   certbot renew --deploy-hook /opt/gini-relay/scripts/reload-caddy.sh
# or symlink this script into /etc/letsencrypt/renewal-hooks/deploy/.
#
# (Wildcard certs renew via DNS-01 — that part is already configured on the host.)
set -euo pipefail
docker exec gini-relay-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
