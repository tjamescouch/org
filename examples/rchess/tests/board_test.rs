use chess_app::game::board::Board;
use chess_app::game::piece::Piece;

#[test]
fn test_initial_king_position() {
    let board = Board::new();
    assert_eq!(board.get_piece(0,4), Some(Piece::WhiteKing));
}

#[test]
fn test_initial_pawn_positions() {
    let board = Board::new();
    for i in 0..8 {
        assert_eq!(board.get_piece(1,i), Some(Piece::WhitePawn));
        assert_eq!(board.get_piece(6,i), Some(Piece::BlackPawn));
    }
}
