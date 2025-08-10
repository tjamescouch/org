# Simple placeholder Makefile for the project.
# Adjust the variables and rules as needed when source files are added.

CC := gcc
CFLAGS := -Wall -Wextra -O2
SRC_DIR := src
BUILD_DIR := build
TARGET := $(BUILD_DIR)/app

# Default target
all: $(TARGET)

# Create build directory if it doesn't exist
$(BUILD_DIR):
