export interface LLMNoiseFilterPass {
  feed(chunk: string):  string;
  flush(): string;
}
