use crate::game::board::{Board, Piece};

/// Simple text renderer for the board.
pub struct BoardRenderer;

impl BoardRenderer {
    pub fn render(board: &Board) -> String {
        let mut output = String::new();
        for rank in (0..8).rev() {
            output.push_str(&format!("{} | ", rank + 1));
            for file in 0..8 {
                let ch = match board.get_piece(rank, file) {
                    Some(Piece::Pawn) => "♙",
                    Some(Piece::Rook) => "♖",
                    Some(Piece::Knight) => "♘",
                    Some(Piece::Bishop) => "♗",
                    Some(Piece::Queen) => "♕",
                    Some(Piece::King) => "♔",
                    None => ".",
                };
                output.push_str(ch);
                output.push(' ');
            }
            output.push('\n');
        }
        output
    }
}
