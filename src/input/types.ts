export enum InputState {
  Idle = "idle",
  Prompt = "prompt",         // answering a normal "You >" question (e.g., @@user)
  Interject = "interject",   // hotkey 'i' path
  ShuttingDown = "shutdown",
}
