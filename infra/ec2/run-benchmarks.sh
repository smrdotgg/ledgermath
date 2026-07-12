#!/usr/bin/env bash
# Runs on a fresh EC2 instance (user-data). Builds C benchmarks, runs them,
# uploads merged JSON to S3, then shuts down (instance terminates).
#
# Required env (injected by launch-runner user-data header):
#   LEDGERMATH_BUCKET      - results/source bucket name
#   LEDGERMATH_SOURCE_KEY  - s3 key of benchmarks/c zip
#   LEDGERMATH_STAGE       - sst stage name
set -euo pipefail

LOG=/var/log/ledgermath-runner.log
exec > >(tee -a "$LOG") 2>&1

# Define these before any fallible work so the EXIT trap can always form an S3 key.
TS="$(date -u +%Y-%m-%dT%H%MZ)"
INSTANCE_ID="unknown"
INSTANCE_TYPE="unknown"
AMI_ID="unknown"
AZ="unknown"
REGION="unknown"

shutdown_now() {
  sync || true
  # InstanceInitiatedShutdownBehavior=terminate: this ends billing.
  shutdown -h now || poweroff || true
}

on_exit() {
  local code=$?
  local outcome="failed"
  local prefix="results/${INSTANCE_TYPE}/${TS}"

  # Cleanup must never recursively trigger this trap or skip shutdown.
  trap - EXIT
  set +e

  if [ "$code" -eq 0 ]; then
    outcome="succeeded"
  fi

  echo "ledgermath-runner: exiting code=$code outcome=$outcome"
  mkdir -p /var/tmp/ledgermath
  printf '{\n  "status": "%s",\n  "exit_code": %d,\n  "stage": "%s",\n  "instance_id": "%s",\n  "instance_type": "%s",\n  "timestamp_utc": "%s"\n}\n' \
    "$outcome" "$code" "${LEDGERMATH_STAGE:-unknown}" "$INSTANCE_ID" \
    "$INSTANCE_TYPE" "$TS" > /var/tmp/ledgermath/status.json

  if [ -n "${LEDGERMATH_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
    echo "ledgermath-runner: uploading diagnostics to s3://${LEDGERMATH_BUCKET}/${prefix}.*"
    aws s3 cp /var/tmp/ledgermath/status.json \
      "s3://${LEDGERMATH_BUCKET}/${prefix}.status.json" \
      --content-type application/json || true
    # Give tee a moment to flush the failure that caused this trap.
    sleep 1
    aws s3 cp "$LOG" "s3://${LEDGERMATH_BUCKET}/${prefix}.log" \
      --content-type text/plain || true
  else
    echo "ledgermath-runner: cannot upload diagnostics (bucket or aws CLI unavailable)"
  fi

  echo "ledgermath-runner: shutting down"
  shutdown_now
  exit "$code"
}
trap on_exit EXIT

: "${LEDGERMATH_BUCKET:?LEDGERMATH_BUCKET is required}"
: "${LEDGERMATH_SOURCE_KEY:?LEDGERMATH_SOURCE_KEY is required}"
: "${LEDGERMATH_STAGE:=unknown}"

echo "ledgermath-runner: start stage=$LEDGERMATH_STAGE bucket=$LEDGERMATH_BUCKET"

# --- metadata (IMDSv2) ---
TOKEN="$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")"
meta() {
  curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/$1"
}
INSTANCE_ID="$(meta instance-id)"
INSTANCE_TYPE="$(meta instance-type)"
AMI_ID="$(meta ami-id)"
AZ="$(meta placement/availability-zone)"
REGION="$(meta placement/region)"

echo "ledgermath-runner: instance=$INSTANCE_ID type=$INSTANCE_TYPE ami=$AMI_ID az=$AZ"

# --- packages ---
dnf install -y gcc make python3 unzip liburing-devel

WORKDIR=/opt/ledgermath
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "ledgermath-runner: downloading s3://$LEDGERMATH_BUCKET/$LEDGERMATH_SOURCE_KEY"
aws s3 cp "s3://${LEDGERMATH_BUCKET}/${LEDGERMATH_SOURCE_KEY}" /tmp/benchmarks-c.zip
mkdir -p benchmarks/c
unzip -qo /tmp/benchmarks-c.zip -d benchmarks/c
rm -f /tmp/benchmarks-c.zip

# Zip archives created by the deployment asset do not preserve executable bits.
chmod +x benchmarks/c/run-all.sh

# Drop any prebuilt artifacts that may have been zipped from a dev machine.
rm -rf benchmarks/c/build

echo "ledgermath-runner: building"
make -C benchmarks/c clean all

echo "ledgermath-runner: running run-all.sh"
mkdir -p /var/tmp/ledgermath
RESULTS=/var/tmp/ledgermath/results.json
./benchmarks/c/run-all.sh >"$RESULTS"

RESULTS_KEY="results/${INSTANCE_TYPE}/${TS}.json"
META_KEY="results/${INSTANCE_TYPE}/${TS}.meta.json"

echo "ledgermath-runner: uploading s3://$LEDGERMATH_BUCKET/$RESULTS_KEY"
aws s3 cp "$RESULTS" "s3://${LEDGERMATH_BUCKET}/${RESULTS_KEY}" \
  --content-type application/json

python3 - <<PY
import json
meta = {
    "stage": "${LEDGERMATH_STAGE}",
    "instance_id": "${INSTANCE_ID}",
    "instance_type": "${INSTANCE_TYPE}",
    "ami_id": "${AMI_ID}",
    "availability_zone": "${AZ}",
    "region": "${REGION}",
    "timestamp_utc": "${TS}",
    "results_key": "${RESULTS_KEY}",
    "source_key": "${LEDGERMATH_SOURCE_KEY}",
}
with open("/var/tmp/ledgermath/meta.json", "w") as f:
    json.dump(meta, f, indent=2)
    f.write("\n")
PY

aws s3 cp /var/tmp/ledgermath/meta.json "s3://${LEDGERMATH_BUCKET}/${META_KEY}" \
  --content-type application/json

echo "ledgermath-runner: done"
# EXIT trap shuts down
