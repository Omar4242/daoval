# Deploying Daoval to AWS — cheapest real path

This replaces the JSON-file demo backend with real Postgres, and runs everything on
one small EC2 instance instead of ECS Fargate + RDS + an ALB. Tested locally end to
end (health check, search, create, transaction bundles, audit logging) against real
Postgres before writing this.

## What changed from the demo backend
- `server/store.js` / `server/index.js` now talk to Postgres (`server/db.js`) instead
  of a JSON file. Same REST surface — `src/services/fhirClient.js` and the rest of the
  frontend need **zero changes**.
- Every request now writes a row to an `access_log` table (method, path, status,
  remote address, timestamp) — this is the raw audit trail HIPAA's audit-controls
  requirement asks for, independent of the app-level `AuditEvent` writes
  `auditService.js` already does.
- `Dockerfile.frontend` + `Caddyfile` build the React app and serve it with automatic
  TLS (Let's Encrypt), reverse-proxying `/fhir/*` to the backend on the same origin —
  no ALB, no separate cert management.

## Step 1 — AWS account setup (one-time)
1. Create/use an AWS account. Enable MFA on the root user.
2. Sign the AWS Business Associate Addendum: **AWS Artifact → Agreements → AWS BAA →
   Accept.** This is free and takes a few minutes — no sales call, no minimum spend.
3. Confirm the services you're about to use are on AWS's HIPAA-eligible list: EC2, EBS,
   S3, and CloudTrail all are.

## Step 2 — launch the EC2 instance
```bash
# Ubuntu 24.04, t4g.small (2 vCPU / 2GB — enough for Postgres + a small Node
# process + Caddy at low traffic). ~$12/month on-demand in us-east-1.
aws ec2 run-instances \
  --image-id <latest-ubuntu-24.04-arm64-ami> \
  --instance-type t4g.small \
  --key-name <your-keypair> \
  --security-group-ids <sg-id> \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=daoval-prod}]'
```
Key points, not optional:
- `Encrypted: true` on the EBS volume — this is where PHI lives at rest.
- Security group: allow only **443** (HTTPS) and **22** (SSH, ideally restricted to
  your IP) inbound. Nothing else. Postgres is never exposed — it's only reachable
  inside the Docker network on the box.
- Allocate an Elastic IP and associate it, so the IP survives a reboot; point your
  domain's DNS A record at it.

## Step 3 — install Docker and deploy
```bash
ssh ubuntu@<elastic-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu   # log out/in after this

git clone <your-repo-url> daoval && cd daoval
cp .env.production.example .env
nano .env   # set POSTGRES_PASSWORD (openssl rand -base64 32) and DOMAIN

docker compose up -d --build
```
Caddy will request a Let's Encrypt cert for `DOMAIN` automatically on first request —
make sure DNS is already pointed at the Elastic IP before this step, or the HTTP
challenge fails.

## Step 4 — backups (non-negotiable for anything holding PHI)
```bash
# Nightly encrypted pg_dump to S3, kept for e.g. 35 days via an S3 lifecycle rule.
# Add as a cron job on the host, or better, as a small sidecar container.
docker compose exec -T db pg_dump -U daoval daoval | gzip | \
  aws s3 cp - s3://<your-backup-bucket>/daoval/$(date +%F).sql.gz \
  --sse aws:kms
```
The S3 bucket needs: encryption enabled (SSE-KMS), versioning on, public access
blocked, and it must also fall under the same AWS BAA (it does automatically — S3 is
BAA-covered, no separate signup).

## Step 5 — turn on audit logging at the account level
```bash
aws cloudtrail create-trail --name daoval-trail --s3-bucket-name <log-bucket>
aws cloudtrail start-logging --name daoval-trail
```
This logs *infrastructure* access (who touched the EC2 instance, security groups,
S3 buckets) — separate from and in addition to the app-level `access_log` table and
`AuditEvent` resources. HIPAA's audit-control requirement wants both layers.

## Estimated monthly cost
| Item | Cost |
|---|---|
| EC2 t4g.small (on-demand) | ~$12 |
| 30GB gp3 EBS, encrypted | ~$2.50 |
| Elastic IP (while attached, free) | $0 |
| S3 backups (few GB) | ~$1 |
| CloudTrail (first trail free, storage only) | ~$1 |
| Domain (if you don't have one) | ~$1/mo amortized |
| **Total** | **~$15–20/month** |

Compare: Supabase Team ($599/mo) or Railway's $1,000/mo committed-spend BAA threshold
for the same compliance requirement.

Reserved Instances or a Savings Plan can cut the EC2 line further once usage is
predictable, but don't bother until the app has real, non-test traffic.

## What this does NOT give you
Signing the BAA and encrypting the box is the technical floor, not the finish line.
Still required, and unrelated to hosting cost:
- **Real authentication.** `AuthContext.jsx` currently has a mock login table and a
  hardcoded MFA code. That cannot go anywhere near real PHI. Swap it for a real IdP —
  AWS Cognito is HIPAA-eligible and free up to 50,000 MAU, which is a Cognito
  User Pool plus a few hours wiring `AuthContext.jsx` to it.
  - **Terminology services.** `src/fhir/codes.js` uses small sample ICD-10/SNOMED/RxNorm
  lists — fine for a demo, not for clinical use.
- **A HIPAA compliance program**, independent of any code or server: a documented risk
  assessment, written policies, workforce training, a breach-notification procedure,
  and BAAs with every other vendor that will touch PHI (error tracking, email,
  analytics — anything you add later). No amount of infrastructure work substitutes
  for this; it's organizational, not technical.
