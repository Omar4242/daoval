#!/usr/bin/env bash
# Restores a Daoval Postgres backup from S3. DESTRUCTIVE — wipes and replaces the
# current database. Use only for disaster recovery or standing up a new instance.
#
# Usage: ./restore-from-s3.sh daoval-db-2026-07-22_02-00-00.sql.gz

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup-filename>"
  echo "List available backups with: aws s3 ls s3://daoval-backups-CHANGE-ME/daily/"
  exit 1
fi

FILENAME="$1"
S3_BUCKET="s3://daoval-backups-CHANGE-ME"
COMPOSE_DIR="$HOME/daoval"
TMP_PATH="/tmp/${FILENAME}"

cd "$COMPOSE_DIR"

echo "This will REPLACE the current database with ${FILENAME}."
read -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo "Downloading ${FILENAME} from S3..."
aws s3 cp "${S3_BUCKET}/daily/${FILENAME}" "$TMP_PATH"

echo "Restoring into the db container..."
gunzip -c "$TMP_PATH" | docker compose exec -T db psql -U daoval -d daoval

rm -f "$TMP_PATH"
echo "Restore complete. Restart the backend so it picks up any schema changes:"
echo "  docker compose restart backend"
