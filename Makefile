# Simple Makefile for building C source files.
# Adjust variables and rules as needed for your project.

CC := gcc
CFLAGS := -Wall -Wextra -O2
SRC_DIR := src
BUILD_DIR := build
TARGET := $(BUILD_DIR)/app

# Default target
all: $(BUILD_DIR) $(TARGET)

# Ensure the build directory exists
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Compile source files (placeholder rule)
# This rule assumes C source files in $(SRC_DIR) with .c extension.
# Adjust as needed for your project structure.
$(TARGET): $(BUILD_DIR) $(wildcard $(SRC_DIR)/*.c)
	$(CC) $(CFLAGS) $^ -o $@

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean

# Commit the updated Makefile
{
  "cmd": "git add Makefile && git commit -m \"chore: update Makefile with proper placeholder rules and clean target\""
}
