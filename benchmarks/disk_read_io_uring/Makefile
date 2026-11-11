# What every benchmark directory offers the runner, in any language:
#
#   make BUILD=<name>   builds build/<name>/<benchmark>, one self-contained file
#   make -s compiler    prints one line naming the compiler and its version
#   make -s resolved    prints what the compiler resolved for this machine
#
# BUILD is `static` (the default, the kind that is recorded) or `dynamic`.

NAME    := disk_read_io_uring
CC      ?= cc
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra -D_GNU_SOURCE
HARNESS := ../harness/c
BUILD   ?= static

ifeq ($(filter $(BUILD),static dynamic),)
$(error BUILD must be static or dynamic, got "$(BUILD)")
endif

LINK_static  := -static
LINK_dynamic :=

OUT := build/$(BUILD)/$(NAME)
SOURCES := $(NAME).c $(HARNESS)/lm.c $(HARNESS)/lm_event.c $(HARNESS)/lm_disk.c

build: $(OUT)

$(OUT): $(SOURCES) $(HARNESS)/lm.h $(HARNESS)/lm_event.h $(HARNESS)/lm_disk.h $(HARNESS)/lm_fixture.h
	mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LINK_$(BUILD)) -I$(HARNESS) -o $@ $(SOURCES)

compiler:
	@$(CC) --version | head -n 1

resolved:
	@$(CC) $(CFLAGS) -Q --help=target

clean:
	rm -rf build

.PHONY: build compiler resolved clean
