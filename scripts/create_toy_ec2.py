#!/usr/bin/env python3
"""Spin up a cheap throwaway EC2 instance in eu-central-1 (Frankfurt) for manual poking.

Uses the AWS CLI (assumed already authenticated). Creates a key pair and a
security group that allows SSH from anywhere, launches a t4g.nano (cheapest
instance type), waits for it to come up, then prints the SSH command.

Tear down when done:
    python3 scripts/create_toy_ec2.py --destroy
"""

import argparse
import json
import logging
import subprocess
import sys
from pathlib import Path

REGION = "eu-central-1"  # Frankfurt, Germany
PROFILE = "tabot-dev"
INSTANCE_TYPE = "t4g.nano"  # cheapest EC2 type (~$0.0046/hr in eu-central-1, ARM)
# Latest Amazon Linux 2023 arm64 AMI, resolved via AWS public SSM parameter
AMI_SSM_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
NAME = "ledgermath-toy"
KEY_PATH = Path.home() / ".ssh" / f"{NAME}.pem"

log = logging.getLogger(NAME)


def aws(*args: str) -> dict | list | str:
    """Run an AWS CLI command and return parsed JSON output."""
    cmd = ["aws", "--profile", PROFILE, "--region", REGION, "--output", "json", *args]
    log.debug("running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        log.error("aws command failed: %s", " ".join(args))
        log.error(result.stderr.strip())
        sys.exit(1)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def ensure_key_pair() -> None:
    existing = aws(
        "ec2", "describe-key-pairs",
        "--filters", f"Name=key-name,Values={NAME}",
    )["KeyPairs"]
    if existing and KEY_PATH.exists():
        log.info("key pair %s already exists, reusing %s", NAME, KEY_PATH)
        return
    if existing:
        log.info("key pair exists in AWS but %s is missing locally; recreating", KEY_PATH)
        aws("ec2", "delete-key-pair", "--key-name", NAME)

    material = aws(
        "ec2", "create-key-pair",
        "--key-name", NAME,
        "--key-type", "ed25519",
    )["KeyMaterial"]
    KEY_PATH.write_text(material)
    KEY_PATH.chmod(0o400)
    log.info("created key pair %s, private key saved to %s", NAME, KEY_PATH)


def ensure_security_group() -> str:
    existing = aws(
        "ec2", "describe-security-groups",
        "--filters", f"Name=group-name,Values={NAME}",
    )["SecurityGroups"]
    if existing:
        sg_id = existing[0]["GroupId"]
        log.info("security group %s already exists (%s), reusing", NAME, sg_id)
        return sg_id

    sg_id = aws(
        "ec2", "create-security-group",
        "--group-name", NAME,
        "--description", "throwaway toy instance, SSH open",
    )["GroupId"]
    aws(
        "ec2", "authorize-security-group-ingress",
        "--group-id", sg_id,
        "--protocol", "tcp",
        "--port", "22",
        "--cidr", "0.0.0.0/0",
    )
    log.info("created security group %s with SSH open to the world", sg_id)
    return sg_id


def latest_ami() -> str:
    ami = aws("ssm", "get-parameter", "--name", AMI_SSM_PARAM)["Parameter"]["Value"]
    log.info("using latest Amazon Linux 2023 arm64 AMI: %s", ami)
    return ami


def launch(sg_id: str, ami: str) -> str:
    instance = aws(
        "ec2", "run-instances",
        "--image-id", ami,
        "--instance-type", INSTANCE_TYPE,
        "--key-name", NAME,
        "--security-group-ids", sg_id,
        "--tag-specifications",
        f"ResourceType=instance,Tags=[{{Key=Name,Value={NAME}}}]",
    )["Instances"][0]
    instance_id = instance["InstanceId"]
    log.info("launched instance %s (%s), waiting for it to start...", instance_id, INSTANCE_TYPE)

    subprocess.run(
        ["aws", "--profile", PROFILE, "--region", REGION, "ec2", "wait", "instance-running",
         "--instance-ids", instance_id],
        check=True,
    )
    return instance_id


def describe(instance_id: str) -> dict:
    return aws(
        "ec2", "describe-instances", "--instance-ids", instance_id,
    )["Reservations"][0]["Instances"][0]


def create() -> None:
    ensure_key_pair()
    sg_id = ensure_security_group()
    instance_id = launch(sg_id, latest_ami())
    info = describe(instance_id)

    public_ip = info.get("PublicIpAddress", "<no public IP>")
    log.info("instance is running")
    log.info("  name:              %s", NAME)
    log.info("  instance id:       %s", instance_id)
    log.info("  instance type:     %s", info["InstanceType"])
    log.info("  region / AZ:       %s / %s", REGION, info["Placement"]["AvailabilityZone"])
    log.info("  AMI:               %s", info["ImageId"])
    log.info("  architecture:      %s", info["Architecture"])
    log.info("  public IP:         %s", public_ip)
    log.info("  private IP:        %s", info.get("PrivateIpAddress", "?"))
    print()
    print("SSH command:")
    print(f"  ssh -i {KEY_PATH} ec2-user@{public_ip}")
    print()
    print("When you're done, destroy everything with:")
    print(f"  python3 {sys.argv[0]} --destroy")


def destroy() -> None:
    reservations = aws(
        "ec2", "describe-instances",
        "--filters",
        f"Name=tag:Name,Values={NAME}",
        "Name=instance-state-name,Values=pending,running,stopping,stopped",
    )["Reservations"]
    instance_ids = [i["InstanceId"] for r in reservations for i in r["Instances"]]

    if instance_ids:
        log.info("terminating %s", ", ".join(instance_ids))
        aws("ec2", "terminate-instances", "--instance-ids", *instance_ids)
        subprocess.run(
            ["aws", "--profile", PROFILE, "--region", REGION, "ec2", "wait", "instance-terminated",
             "--instance-ids", *instance_ids],
            check=True,
        )
        log.info("instances terminated")
    else:
        log.info("no running instances tagged %s", NAME)

    sgs = aws(
        "ec2", "describe-security-groups",
        "--filters", f"Name=group-name,Values={NAME}",
    )["SecurityGroups"]
    if sgs:
        aws("ec2", "delete-security-group", "--group-id", sgs[0]["GroupId"])
        log.info("deleted security group %s", sgs[0]["GroupId"])

    aws("ec2", "delete-key-pair", "--key-name", NAME)
    KEY_PATH.unlink(missing_ok=True)
    log.info("deleted key pair and local private key")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destroy", action="store_true", help="tear everything down")
    args = parser.parse_args()
    destroy() if args.destroy else create()


if __name__ == "__main__":
    main()
