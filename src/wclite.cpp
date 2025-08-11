#include <iostream>
#include <cstdio>
#include <string>
#include <sstream>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <path>\n";
        return 1;
    }

    const char* path = argv[1];
    // Build command: wc -l -w -c "path"
    std::string cmd = std::string("wc -l -w -c \"") + path + "\"";

    // Open pipe to read command output
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
    long long lines = 0, words = 0, bytes = 0;
    std::istringstream iss(buffer);
    iss >> lines >> words >> bytes;
    if (iss.fail()) {
        std::cerr << "Failed to parse wc output.\n";
        return 1;
    }

    std::cout << "lines=" << lines << " words=" << words << " bytes=" << bytes << "\n";
    return 0;
}
