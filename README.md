# Blue/Green Recursive Self-Improvement System

## Overview

This system is a multi-agent framework implementing a blue/green deployment strategy for recursive self-improvement. Multiple generations of agents are created and evaluated in parallel ("blue" and "green" environments). Each new generation must meet or exceed comparable fitness criteria before being promoted to active use. This ensures safe, incremental improvements while maintaining system stability.

Beyond the recursive self-improvement harness, the framework supports defining multiple agent personas, facilitating rich inter-agent communication, and enabling agents to utilize external tools to accomplish their tasks. Agents can be flexibly initialized with different roles and capabilities, allowing them to specialize or collaborate on various tasks. This modular design makes it possible to deploy the framework in diverse scenarios, with recursive self-improvement being one specific mode of operation among many.

## How It Works

- **Agents**: The core agents (`alice`, `bob`, `carol`) are instantiated via the `agent-factory.ts` module. Each agent represents a distinct persona or role within the system.

- **Agent Lifecycle and Interaction Model**: Agents operate through a lifecycle that involves receiving and sending messages, invoking external tools as needed, and performing role-specific functions. Message passing enables agents to communicate and coordinate, supporting complex workflows and collaborative problem-solving. Tool invocation allows agents to extend their capabilities beyond their core logic, while role specialization ensures that each agent contributes uniquely based on its persona.

- **Rollout Directory**: The `rollout` folder contains critical components for managing generation evaluation and promotion:
  - `fitness.ts`: Defines fitness evaluation tasks and criteria.
  - `policy.ts`: Contains policies governing promotion and gating logic.
  - `sh.ts`: Provides shell utilities for running fitness and rollout commands.

- **Autopilot Loop**: The `autopilot.ts` script orchestrates the continuous evaluation process. It schedules fitness runs, enforces rate limits on promotions to avoid rapid or unstable rollouts, and logs results and decisions to `rollout.log`.

## Usage

- **Run Active Agents**

  ```bash
  ts-node src/agent-factory.ts
  ```

- **Run Fitness Evaluation**

  ```bash
  ts-node rollout/fitness.ts
  ```

- **Trigger Rollout Manually**

  ```bash
  ts-node rollout/sh.ts rollout
  ```

- **Run in Autopilot Mode**

  ```bash
  ts-node autopilot.ts
  ```

## Benchmarks

The `bench/bench` harness runs median-run benchmarks that provide reproducible and verifiable tasks for evaluating agent performance. Results from these benchmarks serve as objective fitness measures, allowing consistent comparison across generations and facilitating transparent, evidence-based promotion decisions.

## Development

- To add new fitness tasks or policies, update the relevant files in the `rollout` directory (`fitness.ts`, `policy.ts`).
- Verify changes locally by running fitness evaluations and rollout commands before submitting for promotion.
- Use the benchmark harness to validate performance changes against established baselines.

## Contributing

We welcome contributions! Please follow the current workflow:

1. Branch off from the `candidate` branch.
2. Implement your feature or fix.
3. Submit a pull request with clear descriptions.
4. Ensure all fitness tests pass before the PR is merged.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
