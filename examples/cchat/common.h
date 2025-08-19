#ifndef COMMON_H
#define COMMON_H

#include <iostream>
#include <string>
#include <cstring>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>

constexpr int PORT = 12345;
constexpr size_t BUFFER_SIZE = 4096;

// Simple wrapper for sending a string over a socket.
inline bool send_all(int sockfd, const std::string& data) {
    size_t total_sent = 0;
    while (total_sent < data.size()) {
        ssize_t sent = ::send(sockfd, data.data() + total_sent,
                              data.size() - total_sent, 0);
        if (sent <= 0) return false;
        total_sent += sent;
    }
    return true;
}

// Simple wrapper for receiving a string until newline.
inline bool recv_line(int sockfd, std::string& out) {
    char buf[1];
    out.clear();
    while (true) {
        ssize_t recvd = ::recv(sockfd, buf, 1, 0);
        if (recvd <= 0) return false;
        if (buf[0] == '\n') break;
        out.push_back(buf[0]);
    }
    return true;
}

#endif // COMMON_H
