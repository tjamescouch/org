export enum InputState {
  Idle = "idle",
  Prompt = "prompt",         // answering a normal "user:" question (e.g., 🧍‍♂️user)
  Interject = "interject",   // hotkey 'i' path
  ShuttingDown = "shutdown",
}
