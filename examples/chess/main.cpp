#include <iostream>
#include <vector>
#include <string>
#include <cctype>
#include <sstream>

using namespace std;

// Board representation: 8x8 char array. Uppercase = White, lowercase = Black.
class ChessBoard {
public:
    vector<string> board; // rows 0..7 (rank 8..1)
    bool whiteTurn;
    // Castling rights: KQkq
    bool whiteCanCastleKingSide;
    bool whiteCanCastleQueenSide;
    bool blackCanCastleKingSide;
    bool blackCanCastleQueenSide;
    // En passant target square column (0-7) if a pawn just moved two squares, else -1
    int enPassantTargetCol;

    ChessBoard()
        : board(8, string(8, '.')),
          whiteTurn(true),
          whiteCanCastleKingSide(true), whiteCanCastleQueenSide(true),
          blackCanCastleKingSide(true), blackCanCastleQueenSide(true),
          enPassantTargetCol(-1) {
        setupStartingPosition();
    }

    void setupStartingPosition() {
        const string backRankWhite = "RNBQKBNR";
        const string backRankBlack = "rnbqkbnr";
        board[0] = backRankBlack;
        board[1] = string(8, 'p');
        board[6] = string(8, 'P');
        board[7] = backRankWhite;
    }

    void print() const {
        cout << "  +-----------------+" << endl;
        for (int r = 0; r < 8; ++r) {
            int rank = 8 - r;
            cout << rank << " | ";
            for (int c = 0; c < 8; ++c) {
                char piece = board[r][c];
                cout << (piece == '.' ? '.' : piece);
                if (c != 7) cout << ' ';
            }
            cout << " |" << endl;
        }
        cout << "  +-----------------+" << endl;
        cout << "    a b c d e f g h" << endl;
    }

    bool coordToIndices(const string &coord, int &row, int &col) const {
        if (coord.size() != 2) return false;
        char file = tolower(coord[0]);
        char rank = coord[1];
        if (file < 'a' || file > 'h') return false;
        if (rank < '1' || rank > '8') return false;
        col = file - 'a';
        row = 8 - (rank - '0');
        return true;
    }

    bool isCurrentPlayerPiece(char piece) const {
        if (piece == '.') return false;
        return whiteTurn ? isupper(piece) : islower(piece);
    }
    bool isOpponentPiece(char piece) const {
        if (piece == '.') return false;
        return whiteTurn ? islower(piece) : isupper(piece);
    }

    // Path clearance for sliding pieces
    bool isPathClear(int sr, int sc, int dr, int dc) const {
        int dRow = dr - sr;
        int dCol = dc - sc;
        int stepRow = (dRow == 0) ? 0 : (dRow > 0 ? 1 : -1);
        int stepCol = (dCol == 0) ? 0 : (dCol > 0 ? 1 : -1);
        // Ensure straight line
        if (stepRow != 0 && stepCol != 0 && abs(dRow) != abs(dCol)) return false;
        int r = sr + stepRow, c = sc + stepCol;
        while (r != dr || c != dc) {
            if (board[r][c] != '.') return false;
            r += stepRow; c += stepCol;
        }
        return true;
    }

    bool isLegalPawnMove(int sr, int sc, int dr, int dc, char piece) const {
        int dir = isupper(piece) ? -1 : 1; // white up
        // Simple forward
        if (dc == 0 && dr == sr + dir && board[dr][dc] == '.') return true;
        // Double step from start
        int startRow = isupper(piece) ? 6 : 1;
        if (dc == 0 && sr == startRow && dr == sr + 2*dir &&
            board[sr+dir][sc] == '.' && board[dr][dc] == '.') return true;
        // Capture
        if (abs(dc - sc) == 1 && dr == sr + dir && isOpponentPiece(board[dr][dc]))
            return true;
        // En passant capture
        if (enPassantTargetCol != -1 && abs(dc - sc) == 1 && dr == sr + dir &&
            dc == enPassantTargetCol) {
            // target square must be empty
            if (board[dr][dc] == '.') return true;
        }
        return false;
    }

    bool isLegalMove(int sr, int sc, int dr, int dc) const {
        char piece = board[sr][sc];
        char target = board[dr][dc];
        if (!isCurrentPlayerPiece(piece)) return false;
        if (target != '.' && !isOpponentPiece(target)) return false;

        int dRow = dr - sr;
        int dCol = dc - sc;
        switch (tolower(piece)) {
            case 'p':
                return isLegalPawnMove(sr, sc, dr, dc, piece);
            case 'n':
                return (abs(dRow) == 2 && abs(dCol) == 1) ||
                       (abs(dRow) == 1 && abs(dCol) == 2);
            case 'b':
                return abs(dRow) == abs(dCol) && isPathClear(sr, sc, dr, dc);
            case 'r':
                return ((dRow == 0 || dCol == 0) && isPathClear(sr, sc, dr, dc));
            case 'q':
                return (((abs(dRow) == abs(dCol)) ||
                        (dRow == 0 || dCol == 0)) &&
                       isPathClear(sr, sc, dr, dc));
            case 'k': {
                // Normal king move
                if (abs(dRow) <= 1 && abs(dCol) <= 1) return true;
                // Castling
                if (whiteTurn) {
                    if (sr == 7 && sc == 4) { // white king original square
                        // King side O-O
                        if (dc == 6 && dr == 7 && whiteCanCastleKingSide &&
                            board[7][5] == '.' && board[7][6] == '.') return true;
                        // Queen side O-O-O
                        if (dc == 2 && dr == 7 && whiteCanCastleQueenSide &&
                            board[7][1] == '.' && board[7][2] == '.' && board[7][3] == '.')
                            return true;
                    }
                } else {
                    if (sr == 0 && sc == 4) { // black king original
                        if (dc == 6 && dr == 0 && blackCanCastleKingSide &&
                            board[0][5] == '.' && board[0][6] == '.') return true;
                        if (dc == 2 && dr == 0 && blackCanCastleQueenSide &&
                            board[0][1] == '.' && board[0][2] == '.' && board[0][3] == '.')
                            return true;
                    }
                }
                return false;
            }
            default:
                return false;
        }
    }

    void makeMove(int sr, int sc, int dr, int dc) {
        char piece = board[sr][sc];
        // Handle en passant capture
        if (tolower(piece) == 'p' && enPassantTargetCol != -1 &&
            abs(dc - sc) == 1 && dr == sr + (isupper(piece) ? -1 : 1) &&
            dc == enPassantTargetCol && board[dr][dc] == '.') {
            // capture pawn behind the target square
            int capturedRow = sr;
            board[capturedRow][dc] = '.';
        }

        // Castling move: move rook as well
        if (tolower(piece) == 'k' && abs(dc - sc) == 2) {
            // King side
            if (dc == 6) {
                int rookColFrom = 7;
                int rookColTo = 5;
                board[dr][rookColTo] = board[dr][rookColFrom];
                board[dr][rookColFrom] = '.';
            } else if (dc == 2) { // queen side
                int rookColFrom = 0;
                int rookColTo = 3;
                board[dr][rookColTo] = board[dr][rookColFrom];
                board[dr][rookColFrom] = '.';
            }
        }

        // Promotion
        if (tolower(piece) == 'p' && ((isupper(piece) && dr == 0) || (islower(piece) && dr == 7))) {
            piece = isupper(piece) ? 'Q' : 'q'; // auto promote to queen
        }

        board[dr][dc] = piece;
        board[sr][sc] = '.';

        // Update castling rights if king or rook moved
        if (tolower(piece) == 'k') {
            if (whiteTurn) { whiteCanCastleKingSide = false; whiteCanCastleQueenSide = false; }
            else { blackCanCastleKingSide = false; blackCanCastleQueenSide = false; }
        }
        if (piece == 'R' && sr == 7 && sc == 0) whiteCanCastleQueenSide = false;
        if (piece == 'R' && sr == 7 && sc == 7) whiteCanCastleKingSide = false;
        if (piece == 'r' && sr == 0 && sc == 0) blackCanCastleQueenSide = false;
        if (piece == 'r' && sr == 0 && sc == 7) blackCanCastleKingSide = false;

        // Set en passant target column
        enPassantTargetCol = -1;
        if (tolower(piece) == 'p' && abs(dr - sr) == 2) {
            enPassantTargetCol = dc; // column where capture could occur
        }

        whiteTurn = !whiteTurn;
    }
};

int main() {
    ChessBoard game;
    string line;
    while (true) {
        game.print();
        cout << (game.whiteTurn ? "White" : "Black") << " to move. Enter move (e2e4, O-O, O-O-O) or 'exit': ";
        if (!getline(cin, line)) break;
        if (line.empty()) continue;
        // trim
        stringstream ss(line);
        ss >> line;
        if (line == "exit" || line == "quit") {
            cout << "Goodbye!" << endl;
            break;
        }
        int sr, sc, dr, dc;
        bool parsed = false;
        if ((line == "O-O" || line == "o-o")) {
            // king side castling
            if (game.whiteTurn) { sr = 7; sc = 4; dr = 7; dc = 6; }
            else { sr = 0; sc = 4; dr = 0; dc = 6; }
            parsed = true;
        } else if ((line == "O-O-O" || line == "o-o-o")) {
            // queen side castling
            if (game.whiteTurn) { sr = 7; sc = 4; dr = 7; dc = 2; }
            else { sr = 0; sc = 4; dr = 0; dc = 2; }
            parsed = true;
        } else if (line.size() >= 4) {
            string src = line.substr(0,2);
            string dst = line.substr(2,2);
            if (game.coordToIndices(src,sr,sc) && game.coordToIndices(dst,dr,dc))
                parsed = true;
        }
        if (!parsed) {
            cout << "Invalid input format." << endl;
            continue;
        }
        if (game.isLegalMove(sr, sc, dr, dc)) {
            game.makeMove(sr, sc, dr, dc);
        } else {
            cout << "Illegal move. Try again." << endl;
        }
    }
    return 0;
}
