// fastcalc/main.cpp
// A minimal fast calculator supporting +, -, *, / on integers.
// Build with: g++ -O2 -std=c++17 -o fastcalc fastcalc/main.cpp

#include <iostream>
#include <string>
#include <cctype>
#include <sstream>

class Parser {
public:
    explicit Parser(const std::string& expr) : s(expr), pos(0) {}

    long long parse() { return expression(); }

private:
    const std::string& s;
    size_t pos;

    // Skip whitespace
    void skip_ws() {
        while (pos < s.size() && std::isspace(s[pos])) ++pos;
    }

    // Parse a number (integer)
    long long number() {
        skip_ws();
        bool neg = false;
        if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) {
            neg = (s[pos] == '-');
            ++pos;
        }
        skip_ws();
        long long val = 0;
        bool any = false;
        while (pos < s.size() && std::isdigit(s[pos])) {
            any = true;
            val = val * 10 + (s[pos] - '0');
            ++pos;
        }
        if (!any) throw std::runtime_error("Invalid number");
        return neg ? -val : val;
    }

    // factor := number | '(' expression ')'
    long long factor() {
        skip_ws();
        if (pos < s.size() && s[pos] == '(') {
            ++pos;                     // consume '('
            long long val = expression();
            skip_ws();
            if (pos >= s.size() || s[pos] != ')')
                throw std::runtime_error("Missing closing parenthesis");
            ++pos;                     // consume ')'
            return val;
        }
        return number();
    }

    // term := factor { ('*'|'/') factor }
    long long term() {
        long long lhs = factor();
        while (true) {
            skip_ws();
            if (pos >= s.size()) break;
            char op = s[pos];
            if (op != '*' && op != '/') break;
            ++pos;
            long long rhs = factor();
            if (op == '*')
                lhs *= rhs;
            else {
                if (rhs == 0) throw std::runtime_error("Division by zero");
                lhs /= rhs;
            }
        }
        return lhs;
    }

    // expression := term { ('+'|'-') term }
    long long expression() {
        long long lhs = term();
        while (true) {
            skip_ws();
            if (pos >= s.size()) break;
            char op = s[pos];
            if (op != '+' && op != '-') break;
            ++pos;
            long long rhs = term();
            lhs = (op == '+') ? lhs + rhs : lhs - rhs;
        }
        return lhs;
    }
};

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    std::string line;
    while (std::cout << "fastcalc> " && std::getline(std::cin, line)) {
        if (line.empty()) continue;
        try {
            Parser p(line);
            long long result = p.parse();
            std::cout << result << '\n';
        } catch (const std::exception& e) {
            std::cerr << "Error: " << e.what() << '\n';
        }
    }
    return 0;
}
