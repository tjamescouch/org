# FastCalc – Architecture Overview

## 1. Project Structure
fastcalc/
├─ src/                # Source code (language‑specific)
│   ├─ main.<ext>      # Entry point
│   └─ ...             # Additional modules
├─ test/               # Unit and integration tests
│   └─ *.test.<ext>
├─ docs/               # Documentation
│   └─ architecture.md (this file)
├─ build/              # Build artifacts (generated)
├─ .gitignore
└─ README.md

## 2. Core Components
| Component | Responsibility |
|-----------|----------------|
| **Parser** | Reads user input (e.g., `3 + 4 * 2`) and tokenizes it. |
| **Evaluator** | Implements the expression evaluation using a stack‑based algorithm (Shunting‑Yard or AST interpreter). |
| **UI Layer** | Handles interaction – CLI, web UI, or native GUI depending on chosen language/framework. |
| **Error Handler** | Provides clear messages for syntax errors, division by zero, overflow, etc. |
| **Testing Suite** | Unit tests for parser/evaluator and end‑to‑end tests for the UI. |

## 3. Data Flow
1. **Input Capture** – UI collects a string expression.
2. **Lexical Analysis** – Parser tokenizes the string.
3. **Parsing** – Tokens are transformed into an Abstract Syntax Tree (AST) or Reverse Polish Notation (RPN).
4. **Evaluation** – The evaluator walks the AST/RPN and computes the result.
5. **Output** – Result is displayed back to the user.

## 4. Design Decisions
- **Stateless Evaluation:** Each calculation runs in isolation; no global state needed.
- **Extensible Operator Set:** Operators defined in a config map, making it easy to add functions (e.g., `sin`, `log`).
- **Precision Handling:** Use native numeric types with optional BigInt/Decimal support for high‑precision calculations.
- **Modular Architecture:** Separate parser/evaluator from UI so the same core can be reused across CLI, web, or mobile front‑ends.

## 5. Non‑Functional Requirements
- **Performance:** O(n) parsing/evaluation where n = number of tokens.
- **Portability:** Pure language runtime; no OS‑specific dependencies.
- **Test Coverage:** ≥ 80 % line coverage for core modules.
- **Documentation:** Inline code docs + this architecture guide.

## 6. Next Steps
1. Choose implementation language (e.g., JavaScript/TypeScript, Python, Rust).  
2. Scaffold the repository (`git init`, create `src/` and `test/`).  
3. Implement parser & evaluator skeletons.  
4. Add a simple CLI UI to verify end‑to‑end flow.  

--- 

*Let me know which language you’d like to use, and I’ll set up the initial source files accordingly.*
