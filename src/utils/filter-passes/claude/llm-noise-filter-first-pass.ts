// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private buffer = "";
  
  // Common LLM artifacts and noise patterns
  private readonly noisePatterns = [
    // XML-like tags
    /<\|[^|]*\|>/g,
    /<\/?\w+[^>]*>/g,
    
    // Special tokens and markers
    /\[INST\]|\[\/INST\]/g,
    /\<\/?s\>/g,
    /\<BOS\>|\<EOS\>/g,
    /\<\|start\|>|\<\|end\|>/g,
    /\<\|begin_of_text\|>|\<\|end_of_text\|>/g,
    
    // System prompts bleeding through
    /^\s*System:\s*/gm,
    /^\s*Assistant:\s*/gm,
    /^\s*Human:\s*/gm,
    
    // Model reasoning artifacts
    /\[thinking\].*?\[\/thinking\]/gs,
    /\[reasoning\].*?\[\/reasoning\]/gs,
    /\[analysis\].*?\[\/analysis\]/gs,
    
    // Token boundaries and artifacts
    /\u0001|\u0002|\u0003|\u0004/g, // SOH, STX, ETX, EOT
    /\ufffd/g, // Replacement character
    
    // Repeated punctuation cleanup
    /[.]{3,}/g,
    /[!]{2,}/g,
    /[?]{2,}/g,
    
    // Excessive whitespace
    /[ \t]{3,}/g,
    /\n{4,}/g,
  ];

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    
    this.buffer += chunk;
    const originalLength = this.buffer.length;
    
    // Apply noise removal patterns
    let cleaned = this.buffer;
    for (const pattern of this.noisePatterns) {
      cleaned = cleaned.replace(pattern, (match, ...args) => {
        // For whitespace patterns, replace with single instances
        if (pattern.source.includes('{3,}')) {
          if (match.includes('.')) return '...';
          if (match.includes('!')) return '!';
          if (match.includes('?')) return '?';
          if (match.includes(' ') || match.includes('\t')) return ' ';
          if (match.includes('\n')) return '\n\n\n';
        }
        return '';
      });
    }
    
    // Clean up any resulting double spaces or line breaks
    cleaned = cleaned
      .replace(/  +/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
    
    const removed = originalLength - cleaned.length;
    this.buffer = "";
    
    return {
      cleaned,
      removed: removed > 0 ? removed : 0
    };
  }

  flush(): string {
    if (!this.buffer) return "";
    
    const result = this.feed(this.buffer);
    return result.cleaned;
  }
}