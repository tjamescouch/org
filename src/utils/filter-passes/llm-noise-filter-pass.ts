export interface LLMNoiseFilterPass {
  feed(chunk: string): { cleaned: string };
  flush(): string;
}
