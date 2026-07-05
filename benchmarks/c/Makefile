CC      ?= cc
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra -D_GNU_SOURCE
LDFLAGS ?= -pthread
LDLIBS  ?=

BUILD   := build
HARNESS := harness.c
HARNESS_HDR := harness.h

# Per-benchmark extra libraries (target-specific variables).
# io_uring needs liburing: `apt-get install liburing-dev`.
$(BUILD)/disk_read_io_uring: LDLIBS += -luring

# Every bench_<name>.c compiles+links into build/<name>. Adding a benchmark is a
# single new file — no edits to this Makefile or any shared source.
BENCH_SRCS := $(wildcard bench_*.c)
TARGETS    := $(patsubst bench_%.c,$(BUILD)/%,$(BENCH_SRCS))

all: $(TARGETS)

$(BUILD)/%: bench_%.c $(HARNESS) $(HARNESS_HDR)
	mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ $< $(HARNESS) $(LDFLAGS) $(LDLIBS)

# Run every benchmark and merge their JSON arrays into one array on stdout.
run: all
	./run-all.sh

quick: all
	./run-all.sh --quick

clean:
	rm -rf $(BUILD)

.PHONY: all run quick clean
