#include <iostream>
#include <fstream>
#include <string>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <path>\n";
        return 1;
    }

    const char* path = argv[1];
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        std::cerr << "Error: cannot open file '" << path << "'\n";
        return 1;
    }

    std::size_t lines = 0;
    std::size_t words = 0;
    std::size_t bytes = 0;
    bool in_word = false;
    char ch;
    while (file.get(ch)) {
        ++bytes;
        if (ch == '\n')
            ++lines;

        // wc treats only space, newline, and tab as whitespace separators
        bool is_ws = (ch == ' ' || ch == '\n' || ch == '\t');
        if (is_ws) {
            if (in_word) {
                ++words;
                in_word = false;
            }
        } else {
            in_word = true;
        }
    }
    if (in_word)
        ++words;

    std::cout << "lines=" << lines << " words=" << words << " bytes=" << bytes << "\n";
    return 0;
}
{"id":"call_ri_ka","object":"chat.completion","created":1754880101234,"model":"gpt-oss:120b","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_ri_ka","index":0,"type":"function","function":{"name":"sh","arguments":"{\"cmd\":\"make clean && make\"}"}}]},"finish_reason":"tool_calls"}]}
