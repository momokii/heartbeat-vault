#!/bin/sh
set -eu

node node_modules/@heartbeat-vault/db/dist/migrate.js
node node_modules/@heartbeat-vault/db/dist/seed.js
exec node dist/main.js
