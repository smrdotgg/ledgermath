CC      ?= gcc
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra -D_GNU_SOURCE
LDFLAGS ?= -pthread

TARGET := build/ledgermath-bench
SRC    := ledgermath_bench.c

all: $(TARGET)

$(TARGET): $(SRC)
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

run: $(TARGET)
	./$(TARGET)

quick: $(TARGET)
	./$(TARGET) --quick

clean:
	rm -rf build

.PHONY: all run quick clean
