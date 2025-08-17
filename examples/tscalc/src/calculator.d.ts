export interface Operation {
    (a: number, b: number): number;
}
export declare const operations: Record<string, Operation>;
export declare function evaluateExpression(expr: string): number;
//# sourceMappingURL=calculator.d.ts.map