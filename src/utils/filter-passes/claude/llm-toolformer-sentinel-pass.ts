// src/utils/filter-passes/llm-toolformer-sentinel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

export class ToolformerSentinelPass implements LLMNoiseFilterPass {
  private buffer = "";
  
  // Specific patterns for Toolformer-style tool usage artifacts
  private readonly sentinelPatterns = [
    // Toolformer API call patterns
    /\[API\([^)]*\)\s*→\s*[^\]]*\]/g,
    /\[Calculator\([^)]*\)\s*→\s*[^\]]*\]/g,
    /\[Search\([^)]*\)\s*→\s*[^\]]*\]/g,
    /\[QA\([^)]*\)\s*→\s*[^\]]*\]/g,
    /\[MT\([^)]*\)\s*→\s*[^\]]*\]/g,
    
    // Alternative arrow patterns
    /\[API\([^)]*\)\s*->\s*[^\]]*\]/g,
    /\[Calculator\([^)]*\)\s*->\s*[^\]]*\]/g,
    /\[Search\([^)]*\)\s*->\s*[^\]]*\]/g,
    
    // Bare API calls without results
    /\[API\([^)]*\)\]/g,
    /\[Calculator\([^)]*\)\]/g,
    /\[Search\([^)]*\)\]/g,
    /\[QA\([^)]*\)\]/g,
    /\[MT\([^)]*\)\]/g,
    
    // Function call metadata
    /\[CALL_ID:\s*[^\]]*\]/g,
    /\[TOOL_USE:\s*[^\]]*\]/g,
    /\[FUNCTION:\s*[^\]]*\]/g,
    
    // Retrieval artifacts
    /\[RETRIEVED:\s*[^\]]*\]/g,
    /\[CONTEXT:\s*[^\]]*\]/g,
    /\[REFERENCE:\s*[^\]]*\]/g,
    
    // Model internal reasoning
    /\[REASONING:\s*[^\]]*\]/g,
    /\[LOGIC:\s*[^\]]*\]/g,
    /\[INFERENCE:\s*[^\]]*\]/g,
    
    // Confidence and uncertainty markers
    /\[CONFIDENCE:\s*[^\]]*\]/g,
    /\[UNCERTAINTY:\s*[^\]]*\]/g,
    /\[SCORE:\s*[^\]]*\]/g,
    
    // Multi-line tool blocks
    /\[BEGIN_TOOL\][\s\S]*?\[END_TOOL\]/g,
    /\[START_API\][\s\S]*?\[END_API\]/g,
    /\[TOOL_START\][\s\S]*?\[TOOL_END\]/g,
    
    // JSON-like tool artifacts
    /\{"tool":\s*"[^"]*"[^}]*\}/g,
    /\{"function":\s*"[^"]*"[^}]*\}/g,
    /\{"api_call":\s*"[^"]*"[^}]*\}/g,
  ];

  // Patterns that might be incomplete at chunk boundaries
  private readonly incompletePatterns = [
    /\[API\([^)]*$/,
    /\[Calculator\([^)]*$/,
    /\[Search\([^)]*$/,
    /\[QA\([^)]*$/,
    /\[MT\([^)]*$/,
    /\[[A-Z][a-zA-Z]*\([^)]*$/,
    /\[BEGIN_TOOL$/,
    /\[START_API$/,
    /\{"tool":\s*"[^"]*$/,
    /\{"function":\s*"[^"]*$/,
  ];

  private hasIncompletePattern(text: string): { hasIncomplete: boolean; cutIndex?: number } {
    for (const pattern of this.incompletePatterns) {
      const match = text.match(pattern);
      if (match && match.index !== undefined) {
        return { hasIncomplete: true, cutIndex: match.index };
      }
    }
    return { hasIncomplete: false };
  }

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    
    this.buffer += chunk;
    const originalLength = this.buffer.length;
    
    // Check for incomplete patterns at the end
    const incompleteCheck = this.hasIncompletePattern(this.buffer);
    let processableContent = this.buffer;
    let holdBack = "";
    
    if (incompleteCheck.hasIncomplete && incompleteCheck.cutIndex !== undefined) {
      holdBack = this.buffer.slice(incompleteCheck.cutIndex);
      processableContent = this.buffer.slice(0, incompleteCheck.cutIndex);
    }
    
    // Apply sentinel pattern removal
    let cleaned = processableContent;
    for (const pattern of this.sentinelPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // Clean up formatting after removals
    cleaned = cleaned
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s+|\s+$/gm, '') // Trim each line
      .replace(/\n+/g, '\n');
    
    const removed = processableContent.length - cleaned.length;
    this.buffer = holdBack;
    
    return {
      cleaned,
      removed: removed > 0 ? removed : 0
    };
  }

  flush(): string {
    if (!this.buffer) return "";
    
    let cleaned = this.buffer;
    
    // Apply all patterns without holding back
    for (const pattern of this.sentinelPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // Final cleanup
    cleaned = cleaned
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s+|\s+$/gm, '')
      .replace(/\n+/g, '\n')
      .trim();
    
    this.buffer = "";
    return cleaned;
  }
}