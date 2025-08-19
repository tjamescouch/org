CXX = g++
# Added -pthread to enable linking with the POSIX threads library, required for std::thread.
CXXFLAGS = -std=c++17 -Wall -Wextra -O2 -pthread

SRC_SERVER = server.cpp
SRC_CLIENT = client.cpp
SRC_COMMON = common.h

BIN_SERVER = cchat_server
BIN_CLIENT = cchat_client

all: $(BIN_SERVER) $(BIN_CLIENT)

$(BIN_SERVER): $(SRC_SERVER) $(SRC_COMMON)
	$(CXX) $(CXXFLAGS) -o $@ $(SRC_SERVER)

$(BIN_CLIENT): $(SRC_CLIENT) $(SRC_COMMON)
	$(CXX) $(CXXFLAGS) -o $@ $(SRC_CLIENT)

clean:
	rm -f $(BIN_SERVER) $(BIN_CLIENT) *.o

.PHONY: all clean test
