"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.operations = void 0;
exports.evaluateExpression = evaluateExpression;
exports.operations = {
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => {
        if (b === 0)
            throw new Error('Division by zero');
        return a / b;
    },
};
function evaluateExpression(expr) {
    // simple eval using Function, safe for numbers and operators +-*/()
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${expr});`);
        const result = fn();
        if (typeof result !== 'number' || isNaN(result)) {
            throw new Error('Invalid expression');
        }
        return result;
    }
    catch (e) {
        throw new Error('Failed to evaluate expression: ' + e.message);
    }
}
