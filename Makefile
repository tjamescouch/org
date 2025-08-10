# Simple Makefile for building C source files.
# Adjust variables and rules as needed for your project.

CC := gcc
CFLAGS := -Wall -Wextra -O2
SRC_DIR := src
BUILD_DIR := build
TARGET := $(BUILD_DIR)/app

# Default target
all: $(TARGET)

# Ensure the build directory exists
$(BUILD_DIR):
