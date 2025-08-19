/// Simple move representation and error types.

pub type Move = ((usize, usize), (usize, usize));

#[derive(Debug)]
pub enum MoveError {
    OutOfBounds,
    NoPiece,
}
