#!/usr/bin/env bun
// runner.ts — thin bootstrap that executes src/app.ts

// Importing src/app.ts is enough because src/app.ts calls main() at module load time.
import "./src/app";
