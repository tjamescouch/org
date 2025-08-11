#include <iostream>
#include <fstream>
#include <string>
#include <cctype>

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

        // Use std::isspace to match wc's definition (space, newline, tab, vertical tab, form feed, carriage return)
        bool is_ws = std::isspace(static_cast<unsigned char>(ch));
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
