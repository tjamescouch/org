// src/utils/filter-passes/llm-final-channel-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "../llm-noise-filter-pass";

export class FinalChannelPass implements LLMNoiseFilterPass {
  private buffer = "";
  
  // Patterns for final cleanup and normalization
  private readonly finalPatterns = [
    // Remaining control characters
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,
    
    // Unicode artifacts
    /\uFEFF/g, // BOM
    /\u200B|\u200C|\u200D/g, // Zero-width characters
    /\u2060/g, // Word joiner
    
    // Encoding artifacts
    /&lt;|&gt;|&amp;|&quot;|&#x?\d+;/g,
    
    // Markdown artifacts that shouldn't be there
    /^\s*```[a-z]*\s*$/gm,
    /^\s*---+\s*$/gm,
    
    // Repeated characters that suggest encoding issues
    /(.)\1{5,}/g,
    
    // Malformed URLs or references
    /https?:\/\/[^\s]*\[broken\]/g,
    /\[object Object\]/g,
    /\[object HTMLElement\]/g,
    
    // Debugging output
    /console\.log\([^)]*\);?/g,
    /print\([^)]*\);?/g,
    /echo\s+[^;\n]*;?/g,
    
    // Template literals artifacts
    /\$\{[^}]*\}/g,
    
    // JSON artifacts
    /\{"[^"]*":\s*"[^"]*"\}/g,
    
    // Empty parentheses and brackets
    /\(\s*\)/g,
    /\[\s*\]/g,
    /\{\s*\}/g,
  ];

  // Final whitespace and formatting cleanup
  private normalizeWhitespace(text: string): string {
    return text
      // Normalize line endings
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      
      // Clean up excessive whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      
      // Limit consecutive newlines
      .replace(/\n{4,}/g, '\n\n\n')
      
      // Remove leading/trailing whitespace on lines
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      
      // Clean up paragraph spacing
      .replace(/\n\n+/g, '\n\n')
      .trim();
  }

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    
    this.buffer += chunk;
    const originalLength = this.buffer.length;
    
    // Check for incomplete patterns at the end that might span chunks
    let processableContent = this.buffer;
    let holdBack = "";
    
    // Look for incomplete patterns at the end
    const potentialIncomplete = [
      /&[a-z]*$/,
      /&#\d*$/,
      /&#x[a-f0-9]*$/i,
      /https?:\/\/[^\s]*$/,
      /\$\{[^}]*$/,
      /console\.log\([^)]*$/,
    ];
    
    for (const pattern of potentialIncomplete) {
      const match = processableContent.match(pattern);
      if (match && match.index !== undefined) {
        holdBack = processableContent.slice(match.index);
        processableContent = processableContent.slice(0, match.index);
        break;
      }
    }
    
    // Apply final cleanup patterns
    let cleaned = processableContent;
    for (const pattern of this.finalPatterns) {
      cleaned = cleaned.replace(pattern, (match, ...args) => {
        // Special handling for some patterns
        if (pattern.source.includes('(.)\\\1{5,}')) {
          // For repeated characters, keep just 2-3 instances
          const char = args[0];
          if (char === '.' || char === '-' || char === '=') {
            return char.repeat(3);
          }
          return char.repeat(2);
        }
        
        if (pattern.source.includes('&lt;|&gt;')) {
          // Decode HTML entities
          return match
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
            .replace(/&#x([a-f0-9]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        
        return '';
      });
    }
    
    // Normalize whitespace
    cleaned = this.normalizeWhitespace(cleaned);
    
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
    for (const pattern of this.finalPatterns) {
      cleaned = cleaned.replace(pattern, (match, ...args) => {
        if (pattern.source.includes('(.)\\\1{5,}')) {
          const char = args[0];
          if (char === '.' || char === '-' || char === '=') {
            return char.repeat(3);
          }
          return char.repeat(2);
        }
        
        if (pattern.source.includes('&lt;|&gt;')) {
          return match
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
            .replace(/&#x([a-f0-9]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        
        return '';
      });
    }
    
    cleaned = this.normalizeWhitespace(cleaned);
    this.buffer = "";
    return cleaned;
  }
}