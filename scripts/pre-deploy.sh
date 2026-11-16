#!/bin/sh
set -eu

npx prisma migrate resolve --rolled-back 20261116110000_items_labels_broken > /dev/null 2>&1 || true
npx prisma migrate deploy
npx prisma db seed
