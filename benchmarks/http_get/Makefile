# What every benchmark directory offers the runner, in any language:
#
#   make BUILD=<name>   builds build/<name>/<benchmark>, one self-contained file
#   make -s compiler    prints one line naming the compiler and its version
#   make -s resolved    prints what the compiler resolved for this machine
#
# BUILD is `static` (the default, the kind that is recorded) or `dynamic`.
#
# This one also builds AWS-LC, the TLS library, from its source archive, which
# is not in git: give its path as AWS_LC_ARCHIVE (in the environment or on the
# command line). ../harness/c/vendor/aws-lc.lock pins the archive's hash and
# the build; the library is built once into AWS_LC_DIR and linked statically
# into both builds, and a later `make -B` with the same inputs reuses it.
#
#   make test-driver    builds build/test/http_get_test, which the tests use to
#                       call the DNS, HTTP and SigV4 code directly; never run
#                       by the box

NAME    := http_get
CC      ?= cc
CXX     ?= c++
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra -D_GNU_SOURCE
HARNESS := ../harness/c
BUILD   ?= static

include $(HARNESS)/vendor/aws-lc.lock

AWS_LC_ARCHIVE ?=
AWS_LC_DIR     ?= build/aws-lc
AWS_LC_JOBS    ?= 2

ifeq ($(filter $(BUILD),static dynamic),)
$(error BUILD must be static or dynamic, got "$(BUILD)")
endif

LINK_static  := -static
LINK_dynamic :=

OUT := build/$(BUILD)/$(NAME)

AWS_LC_BUILT   := $(AWS_LC_DIR)/built
AWS_LC_INCLUDE := $(AWS_LC_DIR)/src/include
AWS_LC_LIBS    := $(AWS_LC_DIR)/build/ssl/libssl.a $(AWS_LC_DIR)/build/crypto/libcrypto.a
AWS_LC_DEFINES := -DLM_AWS_LC_VERSION='"$(AWS_LC_VERSION)"' -DLM_AWS_LC_SHA256='"$(AWS_LC_SHA256)"'

PARTS   := $(HARNESS)/lm_lines.c $(HARNESS)/lm_dns.c $(HARNESS)/lm_http.c $(HARNESS)/lm_sigv4.c $(HARNESS)/lm_tls.c
HEADERS := $(HARNESS)/lm.h $(HARNESS)/lm_lines.h $(HARNESS)/lm_dns.h $(HARNESS)/lm_http.h $(HARNESS)/lm_sigv4.h \
           $(HARNESS)/lm_tls.h $(HARNESS)/lm_fixture.h
SOURCES := $(NAME).c $(HARNESS)/lm.c $(PARTS)

build: $(OUT)

$(AWS_LC_BUILT): $(HARNESS)/vendor/aws-lc.lock $(HARNESS)/vendor/build-aws-lc.sh
	@AWS_LC_VERSION='$(AWS_LC_VERSION)' AWS_LC_SHA256='$(AWS_LC_SHA256)' AWS_LC_ARCHIVE_ROOT='$(AWS_LC_ARCHIVE_ROOT)' \
	  AWS_LC_CMAKE_FLAGS='$(AWS_LC_CMAKE_FLAGS)' AWS_LC_TARGETS='$(AWS_LC_TARGETS)' AWS_LC_URL='$(AWS_LC_URL)' \
	  AWS_LC_JOBS='$(AWS_LC_JOBS)' CC='$(CC)' CXX='$(CXX)' \
	  sh $(HARNESS)/vendor/build-aws-lc.sh '$(AWS_LC_ARCHIVE)' '$(AWS_LC_DIR)'

$(OUT): $(SOURCES) $(HEADERS) $(AWS_LC_BUILT)
	mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LINK_$(BUILD)) -I$(HARNESS) -I$(AWS_LC_INCLUDE) $(AWS_LC_DEFINES) -o $@ $(SOURCES) $(AWS_LC_LIBS) -lm -pthread

build/test/$(NAME)_test: test_driver.c $(PARTS) $(HEADERS) $(AWS_LC_BUILT)
	mkdir -p $(@D)
	$(CC) -O1 -g -std=c11 -Wall -Wextra -Werror -D_GNU_SOURCE -I$(HARNESS) -I$(AWS_LC_INCLUDE) $(AWS_LC_DEFINES) \
	  -o $@ test_driver.c $(HARNESS)/lm.c $(PARTS) $(AWS_LC_LIBS) -lm -pthread

test-driver: build/test/$(NAME)_test

compiler:
	@$(CC) --version | head -n 1

resolved:
	@$(CC) $(CFLAGS) -Q --help=target

clean:
	rm -rf build/static build/dynamic build/test

.PHONY: build test-driver compiler resolved clean
