CARGO_TARGET_DIR ?= ../../target
DENO_TEST_FLAGS ?= -A --unsafely-ignore-certificate-errors

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cargo build -p litesvm-deno

test: build
	deno test $(DENO_TEST_FLAGS) mod.test.ts client.test.ts

.PHONY: build test
