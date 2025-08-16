/**
 * Agent utilities
 */

export const withTimeout = <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]) as any;

export const truncate = (s: string, length: number): string => {
  if (s.length <= length) return s;
  return s.slice(0, length) + '...';
};

export const makeToolCallId = (prefix: "call" | "tool"): string => {
  const alphabetArr = "abcdefghijklmnopqrstuvwxyz";
  const randPart = (): string => {
    const first = alphabetArr[Math.floor(Math.random() * alphabetArr.length)];
    const second = alphabetArr[Math.floor(Math.random() * alphabetArr.length)];
    return `${first}${second}`;
  };
  return `${prefix}_${randPart()}_${randPart()}`;
};
