#include <iostream>
#include <vector>
#include <string>
#include <cctype>
#include <sstream>

using namespace std;

// Board representation: 8x8 char array. Uppercase = White, lowercase = Black.
class ChessBoard {
public:
    // board[row][col] where row 0 is rank 8 (top), row 7 is rank 1 (bottom)
    vector<string> board;
    bool whiteTurn; // true if it's White's move

    ChessBoard() : board(8, string(8, '.')), whiteTurn(true) {
        setupStartingPosition();
    }

    void setupStartingPosition() {
        // Set up pieces using standard starting position.
        const string backRankWhite = "RNBQKBNR"; // a1 to h1 (but we store reversed)
        const string backRankBlack = "rnbqkbnr";
        // Rank 8 (row 0) black back rank
        board[0] = backRankBlack;
        // Rank 7 (row 1) black pawns
        board[1] = string(8, 'p');
        // Ranks 6-3 empty already '.'
        // Rank 2 (row 6) white pawns
        board[6] = string(8, 'P');
        // Rank 1 (row 7) white back rank
        board[7] = backRankWhite;
    }

    void print() const {
        cout << "  +-----------------+" << endl;
        for (int r = 0; r < 8; ++r) {
            int rank = 8 - r;
            cout << rank << " | ";
            for (int c = 0; c < 8; ++c) {
                char piece = board[r][c];
                if (piece == '.') cout << ".";
                else cout << piece;
                if (c != 7) cout << " ";
            }
            cout << " |" << endl;
        }
        cout << "  +-----------------+" << endl;
        cout << "    a b c d e f g h" << endl;
    }

    // Convert algebraic coordinate (e.g., "e2") to row and col indices.
    bool coordToIndices(const string &coord, int &row, int &col) const {
        if (coord.size() != 2) return false;
        char file = coord[0];
        char rank = coord[1];
        if (file < 'a' || file > 'h') return false;
        if (rank < '1' || rank > '8') return false;
        col = file - 'a';
        row = 8 - (rank - '0'); // rank '8' -> row 0, rank '1' -> row 7
        return true;
    }

    // Determine if a piece belongs to the current player.
    bool isCurrentPlayerPiece(char piece) const {
        if (piece == '.') return false;
        if (whiteTurn) return isupper(piece);
        else return islower(piece);
    }

    // Determine opponent's color.
    bool isOpponentPiece(char piece) const {
        if (piece == '.') return false;
        if (whiteTurn) return islower(piece);
        else return isupper(piece);
    }

    // Check sliding piece path clearance.
    bool isPathClear(int srcRow, int srcCol, int dstRow, int dstCol) const {
        int dRow = (dstRow - srcRow);
        int dCol = (dstCol - srcCol);
        int stepRow = (dRow == 0) ? 0 : (dRow > 0 ? 1 : -1);
        int stepCol = (dCol == 0) ? 0 : (dCol > 0 ? 1 : -1);
        // Ensure movement is straight line.
        if (stepRow != 0 && stepCol != 0 && abs(dRow) != abs(dCol)) return false; // Not a straight line for bishop/rook
        int curRow = srcRow + stepRow;
        int curCol = srcCol + stepCol;
        while (curRow != dstRow || curCol != dstCol) {
            if (board[curRow][curCol] != '.') return false; // blocked
            curRow += stepRow;
            curCol += stepCol;
        }
        return true;
    }

    bool isLegalMove(int srcRow, int srcCol, int dstRow, int dstCol) const {
        char piece = board[srcRow][srcCol];
        char target = board[dstRow][dstCol];
        // Basic checks: source has current player's piece, destination not own piece.
        if (!isCurrentPlayerPiece(piece)) return false;
        if (target != '.' && !isOpponentPiece(target)) return false; // cannot capture own
        int dRow = dstRow - srcRow;
        int dCol = dstCol - srcCol;
        switch (tolower(piece)) {
            case 'p': { // pawn
                int direction = isupper(piece) ? -1 : 1; // white moves up (row-), black down (row+)
                // Simple move forward one
                if (dCol == 0 && dRow == direction && target == '.') {
                    return true;
                }
                // Double step from starting rank
                int startRow = isupper(piece) ? 6 : 1; // white pawn starts at row 6 (rank2), black at row 1 (rank7)
                if (dCol == 0 && dRow == 2*direction && srcRow == startRow && target == '.' && board[srcRow + direction][srcCol] == '.') {
                    return true;
                }
                // Captures diagonally
                if (abs(dCol) == 1 && dRow == direction && isOpponentPiece(target)) {
                    return true;
                }
                // TODO: en passant not implemented.
                return false;
            }
            case 'n': { // knight
                if ((abs(dRow) == 2 && abs(dCol) == 1) || (abs(dRow) == 1 && abs(dCol) == 2)) {
                    return true;
                }
                return false;
            }
            case 'b': { // bishop
                if (abs(dRow) == abs(dCol) && isPathClear(srcRow, srcCol, dstRow, dstCol)) {
                    return true;
                }
                return false;
            }
            case 'r': { // rook
                if ((dRow == 0 || dCol == 0) && isPathClear(srcRow, srcCol, dstRow, dstCol)) {
                    return true;
                }
                return false;
            }
            case 'q': { // queen
                if (((abs(dRow) == abs(dCol)) || (dRow == 0 || dCol == 0)) && isPathClear(srcRow, srcCol, dstRow, dstCol)) {
                    return true;
                }
                return false;
            }
            case 'k': { // king
                if (abs(dRow) <= 1 && abs(dCol) <= 1) {
                    return true; // no castling
                }
                return false;
            }
            default:
                return false;
        }
    }

    void makeMove(int srcRow, int srcCol, int dstRow, int dstCol) {
        char piece = board[srcRow][srcCol];
        // Handle promotion for pawn reaching last rank.
        if (tolower(piece) == 'p') {
            if ((isupper(piece) && dstRow == 0) || (islower(piece) && dstRow == 7)) {
                // Promote to queen automatically.
                piece = isupper(piece) ? 'Q' : 'q';
            }
        }
        board[dstRow][dstCol] = piece;
        board[srcRow][srcCol] = '.';
        whiteTurn = !whiteTurn; // switch turn
    }
};

int main() {
    ChessBoard game;
    string line;
    while (true) {
        game.print();
        cout << (game.whiteTurn ? "White" : "Black") << " to move. Enter move (e.g., e2e4) or 'exit': ";
        if (!getline(cin, line)) break; // EOF
        if (line.empty()) continue;
        // Trim whitespace
        stringstream ss(line);
        ss >> line;
        if (line == "exit" || line == "quit") {
            cout << "Goodbye!" << endl;
            break;
        }
        if (line.size() < 4) {
            cout << "Invalid input format. Use e.g., e2e4." << endl;
            continue;
        }
        string src = line.substr(0, 2);
        string dst = line.substr(2, 2);
        int srcRow, srcCol, dstRow, dstCol;
        if (!game.coordToIndices(src, srcRow, srcCol) || !game.coordToIndices(dst, dstRow, dstCol)) {
            cout << "Invalid coordinates. Use a-h and 1-8." << endl;
            continue;
        }
        if (game.isLegalMove(srcRow, srcCol, dstRow, dstCol)) {
            game.makeMove(srcRow, srcCol, dstRow, dstCol);
        } else {
            cout << "Illegal move. Try again." << endl;
        }
    }
    return 0;
}

