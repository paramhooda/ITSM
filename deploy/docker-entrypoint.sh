#!/bin/sh
# Entrypoint for the platform container.
#   server  -> run migrations (idempotent, lock-protected), seed defaults, start API + web
#   worker  -> start background job workers (SLA timers, notifications, reports, discovery...)
#   migrate -> run migrations only
#   seed    -> seed defaults/demo data only
set -e
cd /app/apps/api
case "${1:-server}" in
  server)
    node dist/migrate.js
    node dist/seed.js
    exec node dist/index.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  migrate)
    exec node dist/migrate.js
    ;;
  seed)
    exec node dist/seed.js
    ;;
  *)
    exec "$@"
    ;;
esac
