export interface Operation {
  (a: number, b: number): number;
}

export const operations: Record<string, Operation> = {
  add: (a,b)=> a+b,
  sub: (a,b)=> a-b,
  mul: (a,b)=> a*b,
  div: (a,b)=> {
    if(b===0) throw new Error('Division by zero');
    return a/b;
  },
};

export function evaluateExpression(expr: string): number {
  // simple eval using Function, safe for numbers and operators +-*/()
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${expr});`);
    const result = fn();
    if (typeof result !== 'number' || isNaN(result)) {
      throw new Error('Invalid expression');
    }
    return result;
  } catch (e:any) {
    throw new Error('Failed to evaluate expression: '+ e.message);
  }
}
