export abstract class LLMNoiseFilterPass {
  abstract feed(chunk: string): { cleaned: string; removed: number };
  abstract flush(): string; 
}