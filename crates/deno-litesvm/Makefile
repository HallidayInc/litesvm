CARGO_TARGET_DIR ?= ../../target
DENO_TEST_FLAGS ?= -A --unsafely-ignore-certificate-errors
SBF_BUILD_FLAGS ?= --skip-tools-install

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cargo build -p litesvm-deno

test: build
	cargo build-sbf $(SBF_BUILD_FLAGS) --manifest-path ../litesvm/test_programs/realloc-clock/Cargo.toml
	deno test $(DENO_TEST_FLAGS) mod.test.ts client.test.ts syscall_clock.test.ts

.PHONY: build test
