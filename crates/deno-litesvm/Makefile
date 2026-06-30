CARGO_TARGET_DIR ?= ../../target
DENO_TEST_FLAGS ?= -A --unsafely-ignore-certificate-errors
DENO_CONFIG ?= deno.json
SBF_BUILD_FLAGS ?= --skip-tools-install
TEST_SBF_DIR ?= ../litesvm/test_programs/target/deploy

# The three targets we ship prebuilt binaries for
TARGETS := aarch64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
HOST_TARGET := $(shell rustc -vV | sed -n 's/^host: //p')

# Build for the host target only (fast local dev)
build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cargo build --release -p litesvm-deno
	@case "$(HOST_TARGET)" in \
		*-apple-darwin) ext=dylib ;; \
		*) ext=so ;; \
	esac; \
	cp $(CARGO_TARGET_DIR)/release/liblitesvm_deno.$$ext \
	   litesvm_deno.$(HOST_TARGET).$$ext

# Cross-compile for all three targets
# - Host target uses cargo directly
# - Linux targets use cross (requires Docker)
build-all:
	@for t in $(TARGETS); do \
		echo "==> Building $$t"; \
		if [ "$$t" = "$(HOST_TARGET)" ]; then \
			CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cargo build --target $$t --release -p litesvm-deno; \
		else \
			CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cross build --target $$t --release -p litesvm-deno; \
		fi; \
		case "$$t" in \
			*-apple-darwin) ext=dylib ;; \
			*) ext=so ;; \
		esac; \
		cp $(CARGO_TARGET_DIR)/$$t/release/liblitesvm_deno.$$ext \
		   litesvm_deno.$$t.$$ext; \
	done

test: build
	cargo build-sbf $(SBF_BUILD_FLAGS) --manifest-path ../litesvm/test_programs/Cargo.toml --workspace --sbf-out-dir $(TEST_SBF_DIR)
	deno test --config $(DENO_CONFIG) $(DENO_TEST_FLAGS) ts/tests/

.PHONY: build build-all test
