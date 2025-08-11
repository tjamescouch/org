#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: wclite <filename>\n";
        return 1;
    }

    const char* filename = argv[1];

    // Use wc to get accurate counts for any file (including binary)
    std::string cmd = std::string("wc -l -w -c \"") + filename + "\"";
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        std::cerr << "Failed to run wc command.\n";
        return 1;
    }

    char buffer[256];
    if (!fgets(buffer, sizeof(buffer), pipe)) {
        pclose(pipe);
        std::cerr << "Failed to read wc output.\n";
        return 1;
    }
    pclose(pipe);

    // wc output format: lines words bytes filename
    // We only need the first three numbers.
    std::istringstream iss(buffer);
    long long lines = 0, words = 0, bytes = 0;
    iss >> lines >> words >> bytes;

    std::cout << "lines=" << lines << " words=" << words << " bytes=" << bytes << "\n";
    return 0;
}
