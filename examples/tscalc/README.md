# TypeScript Calculator Design

## Project Structure


## Core API ()
- 
  - Parses a simple arithmetic expression supporting , , ,  and parentheses.
  - Uses the operation modules from .
  - Throws  for syntax errors or division by zero.
- 

## Operations ()
Each operation exports a function:

These are pure functions used by the parser/evaluator.

## CLI ( & )
- Supports two modes:
  1. **Command mode** – e.g.  → prints .
  2. **Expression mode** – e.g.  → prints .
- Uses Node's  to dispatch to the appropriate function.
- Handles errors gracefully, printing the error message and exiting with code 1.

## Build & Run
-  – compiles TypeScript to .
-  or  – runs the CLI.

## Scripts (to be added in )


---
*This document outlines the minimal viable structure for a TypeScript calculator library with a CLI.*

