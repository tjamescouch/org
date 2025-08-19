#include <iostream>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include "common.h"

int main(int argc, char* argv[]){
    if(argc<2){std::cerr<<"Usage: "<<argv[0]<<" <server_ip>\n";return 1;}
    int sock=socket(AF_INET,SOCK_STREAM,0);
    struct sockaddr_in serv{};
    serv.sin_family=AF_INET;serv.sin_port=htons(PORT);
    inet_pton(AF_INET,argv[1],&serv.sin_addr);
    connect(sock,(sockaddr*)&serv,sizeof(serv));
    std::string line;while(std::getline(std::cin,line)){
        // Append newline so server can parse
        line += "\n";
        send(sock,line.c_str(),line.size(),0);
    }
    // After sending all input, read echoed responses until server closes
    std::string resp;
    while(recv_line(sock, resp)){
        std::cout << resp << std::endl;
    }
    close(sock);return 0;
}
