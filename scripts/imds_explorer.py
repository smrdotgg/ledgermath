#!/usr/bin/env python3
"""Interactive explorer for the EC2 Instance Metadata Service (IMDSv2).

Run this on the instance itself. Stdlib only, works with plain python3.

Navigation: pick an entry by number, `..` goes up, `q` quits.
Entries ending in `/` are directories; anything else is fetched and printed.
"""

import json
import urllib.request

BASE = "http://169.254.169.254"
TOKEN_TTL = "21600"


def get_token() -> str:
    req = urllib.request.Request(
        f"{BASE}/latest/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": TOKEN_TTL},
    )
    with urllib.request.urlopen(req, timeout=2) as resp:
        return resp.read().decode()


def fetch(token: str, path: str) -> str:
    req = urllib.request.Request(
        f"{BASE}{path}",
        headers={"X-aws-ec2-metadata-token": token},
    )
    with urllib.request.urlopen(req, timeout=2) as resp:
        return resp.read().decode()


def show(body: str) -> None:
    print("-" * 60)
    try:
        print(json.dumps(json.loads(body), indent=2))
    except ValueError:
        print(body)
    print("-" * 60)


def main() -> None:
    token = get_token()
    path = "/latest/"

    while True:
        try:
            entries = fetch(token, path).splitlines()
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code} for {path}")
            path = "/latest/"
            continue

        print(f"\n{path}")
        for i, entry in enumerate(entries):
            print(f"  [{i}] {entry}")

        choice = input("select (number, .. = up, q = quit): ").strip()
        if choice == "q":
            return
        if choice == "..":
            # strip last path segment: /latest/meta-data/placement/ -> /latest/meta-data/
            path = path.rstrip("/").rsplit("/", 1)[0] + "/"
            if not path.startswith("/latest"):
                path = "/latest/"
            continue
        if not choice.isdigit() or int(choice) >= len(entries):
            print("bad choice")
            continue

        entry = entries[int(choice)]
        if entry.endswith("/"):
            path += entry
        else:
            try:
                show(fetch(token, path + entry))
            except urllib.error.HTTPError as e:
                print(f"HTTP {e.code} for {path + entry}")


if __name__ == "__main__":
    main()
