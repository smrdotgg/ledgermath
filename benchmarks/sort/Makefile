# What every benchmark directory offers the runner, in any language:
#
#   make BUILD=<name>   builds build/<name>/<benchmark>, one self-contained file
#   make -s compiler    prints one line naming the compiler and its version
#   make -s resolved    prints what the compiler resolved for this machine
#
# BUILD is `static` (the default, the kind that is recorded) or `dynamic`.

NAME    := sort
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

build: $(OUT)

$(OUT): $(NAME).c $(HARNESS)/lm.c $(HARNESS)/lm.h
	mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LINK_$(BUILD)) -I$(HARNESS) -o $@ $(NAME).c $(HARNESS)/lm.c -pthread

compiler:
	@$(CC) --version | head -n 1

resolved:
	@$(CC) $(CFLAGS) -Q --help=target

clean:
	rm -rf build

.PHONY: build compiler resolved clean
