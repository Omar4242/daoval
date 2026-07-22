# Backups (pg_dump → S3, nightly) + CloudTrail (account-level audit log)

Two separate things, both set up once in the console, then left running.

---

## Part 1 — Nightly database backups to S3

### Step 1: Create the S3 bucket
1. AWS Console → **S3** → **Create bucket**
2. Bucket name: `daoval-backups-<something-unique>` (S3 bucket names are globally unique — add random digits if needed)
3. Region: same region as your EC2 instance
4. **Block all public access**: leave checked (default) — this bucket must never be public
5. **Bucket Versioning**: turn **On** — protects against a corrupted nightly dump silently overwriting a good one
6. **Default encryption**: leave as **Amazon S3-managed keys (SSE-S3)** — this matches the `--sse AES256` flag in the backup script
7. Click **Create bucket**

### Step 2: Add a lifecycle rule (auto-delete old backups so cost doesn't creep up)
1. Open the bucket → **Management** tab → **Create lifecycle rule**
2. Name: `expire-old-backups`
3. Scope: apply to all objects
4. Under **Lifecycle rule actions**, check **Expire current versions of objects**
5. Days after object creation: `90` (adjust to your retention needs — HIPAA doesn't mandate a specific number, but your own policy should state one)
6. Also check **Permanently delete noncurrent versions** → after `30` days, so old versions from the versioning you enabled don't accumulate forever
7. Save

### Step 3: Create an IAM policy scoped to just this bucket
1. **IAM** → **Policies** → **Create policy** → **JSON** tab
2. Paste (replace `daoval-backups-<something-unique>` with your real bucket name):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
         "Resource": [
           "arn:aws:s3:::daoval-backups-<something-unique>",
           "arn:aws:s3:::daoval-backups-<something-unique>/*"
         ]
       }
     ]
   }
   ```
3. Next → name it `DaovalBackupsS3Access` → **Create policy**

### Step 4: Create an IAM role and attach it to the EC2 instance
This is what lets the instance talk to S3 with no access keys stored anywhere on disk.
1. **IAM** → **Roles** → **Create role**
2. Trusted entity type: **AWS service** → Use case: **EC2** → Next
3. Attach the `DaovalBackupsS3Access` policy you just made → Next
4. Name it `daoval-ec2-role` → **Create role**
5. Go to **EC2** → **Instances** → select your Daoval instance
6. **Actions** → **Security** → **Modify IAM role**
7. Select `daoval-ec2-role` → **Update IAM role**

(If the instance already has a role attached from before, go to **IAM → Roles → [that role] → Add permissions → Attach policies** and attach `DaovalBackupsS3Access` to it instead of creating a second role.)

### Step 5: Install the AWS CLI on the instance (if not already there)
```bash
which aws || (curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
  && unzip awscliv2.zip && sudo ./aws/install)
```
No `aws configure` needed — the instance role from Step 4 is picked up automatically.

### Step 6: Set the bucket name in the backup script
The script is already in your repo at `scripts/backup-to-s3.sh` and `scripts/restore-from-s3.sh`. Edit the bucket name in both:
```bash
sed -i 's|daoval-backups-CHANGE-ME|daoval-backups-<something-unique>|' ~/daoval/scripts/backup-to-s3.sh
sed -i 's|daoval-backups-CHANGE-ME|daoval-backups-<something-unique>|' ~/daoval/scripts/restore-from-s3.sh
chmod +x ~/daoval/scripts/backup-to-s3.sh ~/daoval/scripts/restore-from-s3.sh
```

### Step 7: Test it manually before trusting it to cron
```bash
~/daoval/scripts/backup-to-s3.sh
```
Then confirm it actually landed in S3:
```bash
aws s3 ls s3://daoval-backups-<something-unique>/daily/
```

### Step 8: Schedule it nightly with cron
```bash
crontab -e
```
Add this line (runs at 2:00 AM server time — check `date` on the instance to know what timezone that is):
```
0 2 * * * /home/ubuntu/daoval/scripts/backup-to-s3.sh >> /home/ubuntu/daoval-backups/backup.log 2>&1
```
Save and exit. Verify it's registered:
```bash
crontab -l
```

### Restoring, if you ever need to
```bash
aws s3 ls s3://daoval-backups-<something-unique>/daily/     # find the filename you want
~/daoval/scripts/restore-from-s3.sh daoval-db-2026-07-22_02-00-00.sql.gz
```
It asks for a typed `yes` before doing anything, since it overwrites the live database.

**Worth doing once, now:** actually run a restore against a throwaway test, not just trust the script exists. A backup you've never restored isn't verified — it's a hope.

---

## Part 2 — CloudTrail (account-level audit log)

This logs every API call made against your AWS account (console logins, EC2 changes, IAM changes, S3 access, everything) — independent of your application, and it's what you'd hand an auditor if you ever needed to show "who changed what, when" at the infrastructure level.

### Step 1: Create the trail
1. AWS Console → **CloudTrail** → **Trails** → **Create trail**
2. Trail name: `daoval-account-trail`
3. **Storage location**: choose **Create new S3 bucket** (don't reuse the backups bucket — keep audit logs separate) → name it something like `daoval-cloudtrail-logs-<something-unique>`
4. **Log file SSE-KMS encryption**: leave enabled (default) — CloudTrail manages the KMS key for you
5. Leave **CloudWatch Logs** off unless you want live searching/alerting later (it adds a small monthly cost) — the S3 copy alone is enough to satisfy "we have an audit trail"
6. Next

### Step 2: Choose what to log
1. **Management events**: check this — this is the important one (who created/deleted/modified any AWS resource, including console sign-ins)
2. **Read/Write**: leave as **All**
3. **Data events**: skip for now (logs every individual S3 object read/write — high volume, not needed unless you specifically need object-level access logs later)
4. Next → review → **Create trail**

### Step 3: Confirm it's logging
1. Open the trail you just created → it should show **Logging: On**
2. Give it 10–15 minutes, then check the S3 bucket it created — you should see log files starting to appear under a path like `AWSLogs/<account-id>/CloudTrail/`

### Step 4: (Optional but recommended) Get alerted on root account usage
Since this is a small single-admin setup, the highest-value alert is "did anyone log in as root or make an IAM change."
1. **CloudTrail** → your trail → note it's already capturing this
2. For actual email alerts, that requires wiring CloudTrail → CloudWatch Logs → a metric filter → SNS — a bit more setup. Worth doing later; not blocking for now. Say the word if you want this next.

### What this gets you
- A permanent, tamper-evident record of every change made to your AWS account — separate from whatever the app itself logs in `access_log`
- If your AWS account credentials were ever compromised, CloudTrail is how you'd find out what the attacker did
- Standard expectation for any HIPAA-adjacent infrastructure, alongside your existing BAA

---

## Cost note
Both of these are effectively free at your scale: S3 storage for nightly compressed SQL dumps of a small clinic's data is pennies/month, and CloudTrail's first trail with management events only has no additional charge beyond the S3 storage for the logs themselves (also pennies/month).
