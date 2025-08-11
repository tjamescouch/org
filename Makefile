# Makefile for building the wclite utility and running tests/benchmark.

# Compilers and flags
CC := gcc
CFLAGS := -Wall -Wextra -O2

CXX := g++
CXXFLAGS := -Wall -Wextra -O2 -std=c++17

# Directories
SRC_DIR := src
BUILD_DIR := build

# Targets
TARGET_WCLITE := $(BUILD_DIR)/wclite

# Default target builds wclite
all: $(BUILD_DIR) $(TARGET_WCLITE)

# Ensure build directory exists
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Build wclite from C++ source
$(TARGET_WCLITE): $(SRC_DIR)/wclite.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) $< -o $@

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean

# Convenience targets
test: all
	bash tests/run.sh

bench: all
	bash bench/bench.sh

# Commit changes (optional helper, not executed automatically)
# git add Makefile src/wclite.cpp tests/run.sh bench/bench.sh && git commit -m "feat: add wclite utility with tests and benchmark"
