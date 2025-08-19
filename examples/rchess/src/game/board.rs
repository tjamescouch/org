// Simple representation of a chess board.
// For now we just store an 8x8 array of optional pieces.

#[derive(Debug, Clone)]
pub struct Board {
    squares: [[Option<Piece>; 8]; 8],
}

#[derive(Debug, Clone, Copy)]
pub enum Piece {
    Pawn,
    Rook,
    Knight,
    Bishop,
    Queen,
    King,
}

impl Board {
    pub fn new() -> Self {
        // Initialize with a standard starting position
        let mut squares = [[None; 8]; 8];
        // Pawns
        for i in 0..8 {
            squares[1][i] = Some(Piece::Pawn);
            squares[6][i] = Some(Piece::Pawn);
        }
        // Rooks
        squares[0][0] = Some(Piece::Rook);
        squares[0][7] = Some(Piece::Rook);
        squares[7][0] = Some(Piece::Rook);
        squares[7][7] = Some(Piece::Rook);
        // Knights
        squares[0][1] = Some(Piece::Knight);
        squares[0][6] = Some(Piece::Knight);
        squares[7][1] = Some(Piece::Knight);
        squares[7][6] = Some(Piece::Knight);
        // Bishops
        squares[0][2] = Some(Piece::Bishop);
        squares[0][5] = Some(Piece::Bishop);
        squares[7][2] = Some(Piece::Bishop);
        squares[7][5] = Some(Piece::Bishop);
        // Queens
        squares[0][3] = Some(Piece::Queen);
        squares[7][3] = Some(Piece::Queen);
        // Kings
        squares[0][4] = Some(Piece::King);
        squares[7][4] = Some(Piece::King);

        Board { squares }
    }

    /// Return the piece at a given rank/file (0-indexed). Returns None if empty.
    pub fn get_piece(&self, rank: usize, file: usize) -> Option<Piece> {
        if rank < 8 && file < 8 {
            self.squares[rank][file]
        } else {
            None
        }
    }
}
