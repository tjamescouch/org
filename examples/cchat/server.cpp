#include "common.h"
#include <thread>
#include <vector>

void handle_client(int client_sock) {
    std::string line;
    while (recv_line(client_sock, line)) {
        // Echo back the received line with a prefix.
        std::string response = "[SERVER] " + line + "\n";
        if (!send_all(client_sock, response)) break;
    }
    close(client_sock);
}

int main() {
    int listen_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_sock < 0) {
        perror("socket");
        return 1;
    }

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(PORT);

    int opt = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    if (bind(listen_sock, (sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        return 1;
    }

    if (listen(listen_sock, SOMAXCONN) < 0) {
        perror("listen");
        return 1;
    }

    std::cout << "cchat server listening on port " << PORT << std::endl;

    std::vector<std::thread> workers;
    while (true) {
        int client_sock = accept(listen_sock, nullptr, nullptr);
        if (client_sock < 0) {
            perror("accept");
            continue;
        }
        workers.emplace_back(std::thread(handle_client, client_sock));
    }

    for (auto& t : workers) t.join();
    close(listen_sock);
    return 0;
}
