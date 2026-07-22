#!/usr/bin/env bash
# Nightly Postgres backup for Daoval: dumps the DB running in the `db` container,
# compresses it, uploads it to S3 (server-side encrypted), and prunes local copies.
#
# Requires: the AWS CLI installed on the EC2 host, and an IAM role attached to the
# instance (via an instance profile) with s3:PutObject / s3:ListBucket on the backup
# bucket — see BACKUPS.md for how to set that up in the console. This script does NOT
# use IAM access keys; it relies on the instance role, so nothing here can leak a key.
#
# Usage: run manually to test, or via cron (see BACKUPS.md for the crontab line).

set -euo pipefail

# ---- config: edit these two if your setup differs ----
S3_BUCKET="s3://daoval-backups-CHANGE-ME"     # set this to the bucket you create in BACKUPS.md
COMPOSE_DIR="$HOME/daoval"                     # folder containing docker-compose.yml
LOCAL_BACKUP_DIR="$HOME/daoval-backups"        # local staging dir before upload
KEEP_LOCAL_DAYS=3                              # local copies older than this are deleted
# --------------------------------------------------------

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
FILENAME="daoval-db-${TIMESTAMP}.sql.gz"
LOCAL_PATH="${LOCAL_BACKUP_DIR}/${FILENAME}"

mkdir -p "$LOCAL_BACKUP_DIR"
cd "$COMPOSE_DIR"

echo "[$(date)] Starting backup: ${FILENAME}"

# Dump straight out of the running `db` container, compress on the way to disk.
docker compose exec -T db pg_dump -U daoval -d daoval | gzip > "$LOCAL_PATH"

if [ ! -s "$LOCAL_PATH" ]; then
  echo "[$(date)] ERROR: backup file is empty — aborting upload." >&2
  rm -f "$LOCAL_PATH"
  exit 1
fi

echo "[$(date)] Dump complete ($(du -h "$LOCAL_PATH" | cut -f1)). Uploading to S3..."

aws s3 cp "$LOCAL_PATH" "${S3_BUCKET}/daily/${FILENAME}" \
  --sse AES256 \
  --only-show-errors

echo "[$(date)] Upload complete."

# Prune local copies older than KEEP_LOCAL_DAYS — S3 is the durable copy; the local
# staging dir is just a scratch area, not a second backup location, so this is safe.
find "$LOCAL_BACKUP_DIR" -name "daoval-db-*.sql.gz" -mtime +"$KEEP_LOCAL_DAYS" -delete

echo "[$(date)] Done."
