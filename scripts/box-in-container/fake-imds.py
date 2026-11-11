#!/usr/bin/env python3
"""A stand-in for the EC2 instance metadata service, for scripts/box-in-container/run.sh.

    python3 fake-imds.py INSTANCE_TYPE

It puts 169.254.169.254 on this network namespace's loopback (it needs
CAP_NET_ADMIN), then answers IMDSv2 there on port 80: a token for PUT
/latest/api/token, and, for a request carrying that token, the metadata
runner/run.py and runner/box.sh read, saying the box is an INSTANCE_TYPE in
us-east-2c. The ids are the documentation's examples, so no Run it shapes can
be taken for a real instance's. The box's container joins this one's network
namespace (docker run --network container:...), so the host's own routes, and
its own IMDS, are untouched.

Python 3 with no packages: it runs on the box's image.
"""

import fcntl
import http.server
import json
import socket
import struct
import sys

ADDRESS = "169.254.169.254"
TOKEN = "fake-imds-token"
SIOCSIFADDR = 0x8916
SIOCSIFNETMASK = 0x891C


def add_address():
    """ip addr add 169.254.169.254/32 dev lo, without the ip command."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for request, address in ((SIOCSIFADDR, ADDRESS), (SIOCSIFNETMASK, "255.255.255.255")):
            ifreq = struct.pack("16sH2s4s8s", b"lo:imds", socket.AF_INET, b"\0" * 2, socket.inet_aton(address), b"\0" * 8)
            fcntl.ioctl(sock, request, ifreq)


def metadata(instance_type):
    document = {
        "accountId": "123456789012",
        "architecture": "x86_64",
        "availabilityZone": "us-east-2c",
        "imageId": "ami-0123456789abcdef0",
        "instanceId": "i-0123456789abcdef0",
        "instanceType": instance_type,
        "region": "us-east-2",
    }
    return {
        "/latest/dynamic/instance-identity/document": json.dumps(document, indent=2),
        "/latest/meta-data/instance-id": document["instanceId"],
        "/latest/meta-data/instance-type": instance_type,
        "/latest/meta-data/ami-id": document["imageId"],
        "/latest/meta-data/instance-life-cycle": "on-demand",
        "/latest/meta-data/placement/region": "us-east-2",
        "/latest/meta-data/placement/availability-zone": "us-east-2c",
        "/latest/meta-data/placement/availability-zone-id": "use2-az3",
    }


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: fake-imds.py INSTANCE_TYPE")
    answers = metadata(sys.argv[1])

    class Handler(http.server.BaseHTTPRequestHandler):
        def reply(self, status, body=""):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_PUT(self):
            if self.path == "/latest/api/token" and self.headers.get("X-aws-ec2-metadata-token-ttl-seconds"):
                self.reply(200, TOKEN)
            else:
                self.reply(400)

        def do_GET(self):
            if self.headers.get("X-aws-ec2-metadata-token") != TOKEN:
                self.reply(401)
            elif self.path in answers:
                self.reply(200, answers[self.path])
            else:
                self.reply(404)

    add_address()
    server = http.server.HTTPServer((ADDRESS, 80), Handler)
    print("fake-imds: answering as %s on %s:80" % (sys.argv[1], ADDRESS), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
