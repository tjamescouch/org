## Architecture Document – TaskStats CLI Utility

**Project:** `org` (workspace sub‑project)  
**Component:** `taskstats` – a minimal C++ command‑line tool that reports basic text statistics (lines, words, characters).  

### Scope
- Provide a single executable `taskstats` that can:
  1. Read from **stdin** or a file path argument.
  2. Output three numbers: **lines**, **words**, **characters** (similar to Unix `wc`).
- Keep the implementation ≤ 200 LOC.
- Include a small test harness (shell script) that validates the output against known inputs.
- Build with a simple `Makefile` using `g++` (C++17).

### Modules
| Module | Responsibility |
|--------|----------------|
| `src/main.cpp` | Parses CLI arguments, reads input, computes statistics, prints results. |
| `src/stats.hpp` / `src/stats.cpp` | Pure functions: `countLines`, `countWords`, `countChars`. |
| `Makefile` | Defines `all`, `clean`, and `test` targets. |
| `tests/run.sh` | Executes the binary on sample data, compares to expected output. |

### Build Plan
1. **Compilation** – `g++ -std=c++17 -Wall -Wextra -O2 -Iinclude src/*.cpp -o taskstats`.
2. **Testing** – `make test` runs `tests/run.sh`. The script feeds a known string to the binary and checks the three numbers.
3. **Packaging** – The binary will be placed in the project root (`workspace/taskstats/`) for easy execution.

### Extensibility
- Additional statistics (e.g., longest line, average word length) can be added by extending `stats.hpp`.
- A `--json` flag could output results in JSON format for downstream tooling.

### Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Platform‑specific line endings (`\r\n` vs `\n`) | Incorrect line count on Windows files | Use `std::getline` which handles both `\n` and `\r\n`. |
| Large files exceeding memory | High RAM usage if whole file is read at once | Process input line‑by‑line; only keep counters. |
| Missing Makefile target | Build failures | Keep `Makefile` minimal and test locally after each change. |

### Acceptance Criteria (Fitness Checklist)
- `make` builds `taskstats` without warnings.
- `make test` passes all supplied test cases.
- `README.md` contains build instructions and usage examples.
- Architecture document stays in sync with code (module list matches files).
