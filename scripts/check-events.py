#!/usr/bin/env python3
"""Check a benchmark's stdout against the event contract.

    ./build/static/memory_read --quick | python3 scripts/check-events.py --quick
    python3 scripts/check-events.py --samples 10 stdout.ndjson

The contract is docs/dev-log.md section 2. schemas/events.schema.json gives the
shape of each line; this script also checks what a schema cannot: the order of
the stream. Needs nothing but Python 3.

Exit status 0 when the stream is valid, 1 when it is not, 2 on bad usage.
"""

import argparse
import json
import re
import sys

SCHEMA = "ledgermath.events/1"
UNIVERSAL = {"started", "observed", "sample_started", "sample_ended", "verified", "finished"}
WALL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$")
CHECKSUM = re.compile(r"^0x[0-9a-f]{16}$")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def check(lines, expect_samples=None, expect_quick=False):
    """Returns a list of problems, empty when the stream is valid."""
    problems = []

    def bad(number, message):
        problems.append("line %d: %s" % (number, message))

    events = []
    for number, line in enumerate(lines, start=1):
        if line == "":
            bad(number, "blank line")
            continue
        try:
            event = json.loads(line)
        except ValueError as error:
            bad(number, "not JSON: %s" % error)
            continue
        if not isinstance(event, dict):
            bad(number, "not a JSON object")
            continue
        if not isinstance(event.get("event"), str):
            bad(number, '"event" must be a string')
            continue
        if not is_int(event.get("t")) or event["t"] < 0:
            bad(number, '"t" must be a whole number of nanoseconds')
            continue
        events.append((number, event))

    if not events:
        return problems + ["no events"]

    first_number, first = events[0]
    if first["event"] != "started":
        bad(first_number, 'the first event must be "started", got "%s"' % first["event"])
    last_number, last = events[-1]
    if last["event"] != "finished":
        bad(last_number, 'the last event must be "finished", got "%s"' % last["event"])

    observed_keys = {}
    open_sample = None        # (sample, t) of a sample_started with no sample_ended yet
    next_sample = 0
    last_sample_end = None
    counted = 0
    seen = {name: 0 for name in UNIVERSAL}

    for number, event in events:
        name = event["event"]
        if name in seen:
            seen[name] += 1

        if name == "started":
            if seen["started"] > 1:
                bad(number, '"started" appears more than once')
            if event.get("schema") != SCHEMA:
                bad(number, '"schema" must be "%s"' % SCHEMA)
            if not isinstance(event.get("wall_utc"), str) or not WALL_UTC.match(event["wall_utc"]):
                bad(number, '"wall_utc" must look like 2026-01-02T03:04:05.123456789Z')
            if not isinstance(event.get("clock"), str) or not event["clock"]:
                bad(number, '"clock" must name the clock')
            if not is_number(event.get("clock_read_ns")) or event["clock_read_ns"] < 0:
                bad(number, '"clock_read_ns" must be a non-negative number')
            quick = event.get("quick", False)
            if not isinstance(quick, bool):
                bad(number, '"quick" must be true or false')
            elif quick and not expect_quick:
                bad(number, "this is a --quick stream; pass --quick if that is intended")
            elif not quick and expect_quick:
                bad(number, "expected a --quick stream")

        elif name == "observed":
            values = event.get("values")
            if not isinstance(values, dict):
                bad(number, '"values" must be an object')
            else:
                for key in values:
                    if key in observed_keys:
                        bad(number, 'observed key "%s" was already emitted on line %d' % (key, observed_keys[key]))
                    observed_keys[key] = number

        elif name == "sample_started":
            sample = event.get("sample")
            if open_sample is not None:
                bad(number, "sample %s started before sample %s ended" % (sample, open_sample[0]))
            if not is_int(sample) or sample != next_sample:
                bad(number, '"sample" must be %d, got %r' % (next_sample, sample))
            if not isinstance(event.get("warmup"), bool):
                bad(number, '"warmup" must be true or false')
            elif not event["warmup"]:
                counted += 1
            if not is_int(event.get("repetitions")) or event["repetitions"] < 1:
                bad(number, '"repetitions" must be a whole number of at least 1')
            if last_sample_end is not None and event["t"] < last_sample_end:
                bad(number, "sample %s starts before the previous sample ended" % sample)
            open_sample = (sample, event["t"])
            next_sample += 1

        elif name == "sample_ended":
            sample = event.get("sample")
            if open_sample is None:
                bad(number, "sample_ended with no sample open")
            else:
                if sample != open_sample[0]:
                    bad(number, '"sample" must be %r, got %r' % (open_sample[0], sample))
                if event["t"] < open_sample[1]:
                    bad(number, "sample %s ends before it starts" % sample)
                last_sample_end = event["t"]
                open_sample = None

        elif name == "verified":
            if seen["verified"] > 1:
                bad(number, '"verified" appears more than once')
            if not isinstance(event.get("checksum"), str) or not CHECKSUM.match(event["checksum"]):
                bad(number, '"checksum" must be 0x and sixteen lowercase hex digits')

        elif name == "finished":
            if seen["finished"] > 1:
                bad(number, '"finished" appears more than once')

    if open_sample is not None:
        problems.append("sample %s never ended" % open_sample[0])
    if seen["verified"] == 0:
        problems.append('no "verified" event')
    if counted == 0:
        problems.append("no counted sample (warmup false)")
    if expect_samples is not None and counted != expect_samples:
        problems.append("expected %d counted samples, found %d" % (expect_samples, counted))
    return problems


def main():
    parser = argparse.ArgumentParser(description="Check a benchmark's stdout against the event contract.")
    parser.add_argument("file", nargs="?", help="the stream; stdin when omitted")
    parser.add_argument("--samples", type=int, help="the number of counted samples to expect (LM_SAMPLES)")
    parser.add_argument("--quick", action="store_true", help="expect a --quick stream")
    args = parser.parse_args()

    if args.file:
        with open(args.file, encoding="utf-8") as handle:
            text = handle.read()
    else:
        text = sys.stdin.read()
    if text and not text.endswith("\n"):
        print("the stream does not end with a newline", file=sys.stderr)
        return 1
    lines = text.split("\n")[:-1] if text else []

    problems = check(lines, expect_samples=args.samples, expect_quick=args.quick)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("ok: %d events" % len(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
