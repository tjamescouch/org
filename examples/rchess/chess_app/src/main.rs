use std::fmt;

#[derive(Clone, Copy)]
enum Piece {
    Pawn(char),
    Rook(char),
    Knight(char),
    Bishop(char),
    Queen(char),
    King(char),
}

impl fmt::Display for Piece {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ch = match *self {
            Piece::Pawn(c) => c,
            Piece::Rook(c) => c,
            Piece::Knight(c) => c,
            Piece::Bishop(c) => c,
            Piece::Queen(c) => c,
            Piece::King(c) => c,
        };
        write!(f, "{}", ch)
    }
}

#[derive(Clone)]
struct Board {
    squares: [[Option<Piece>; 8]; 8],
}

impl Board {
    fn new() -> Self {
        let mut squares = [[None; 8]; 8];

        // Place pawns
        for i in 0..8 {
            squares[1][i] = Some(Piece::Pawn('♙'));
            squares[6][i] = Some(Piece::Pawn('♟'));
        }

        // Rooks
        squares[0][0] = Some(Piece::Rook('♖'));
        squares[0][7] = Some(Piece::Rook('♗'));
        squares[7][0] = Some(Piece::Rook('♜'));
        squares[7][7] = Some(Piece::Rook('♝'));

        // Knights
        squares[0][1] = Some(Piece::Knight('♘'));
        squares[0][6] = Some(Piece::Knight('♗'));
        squares[7][1] = Some(Piece::Knight('♞'));
        squares[7][6] = Some(Piece::Knight('♜'));

        // Bishops
        squares[0][2] = Some(Piece::Bishop('♗'));
        squares[0][5] = Some(Piece::Bishop('♘'));
        squares[7][2] = Some(Piece::Bishop('♝'));
        squares[7][5] = Some(Piece::Bishop('♜'));

        // Queens
        squares[0][3] = Some(Piece::Queen('♕'));
        squares[7][3] = Some(Piece::Queen('♛'));

        // Kings
        squares[0][4] = Some(Piece::King('♔'));
        squares[7][4] = Some(Piece::King('♚'));

        Board { squares }
    }

    fn display(&self) {
        println!("  a b c d e f g h");
        for (i, row) in self.squares.iter().enumerate() {
            print!("{} ", 8 - i);
            for sq in row.iter() {
                match sq {
                    Some(p) => print!("{} ", p),
                    None => print!(". "),
                }
            }
            println!("{}", 8 - i);
        }
        println!("  a b c d e f g h");
    }

    fn move_piece(&mut self, from: &str, to: &str) -> Result<(), String> {
        let (fx, fy) = Self::parse_coord(from)?;
        let (tx, ty) = Self::parse_coord(to)?;

        if fx == tx && fy == ty {
            return Err("Source and destination are the same".into());
        }

        let piece = self.squares[fy][fx].ok_or("No piece at source")?;
        // Basic validation: only allow pawn forward move by one
        match piece {
            Piece::Pawn(_) => {
                if fx == tx && (fy + 1) % 8 == ty {
                    self.squares[ty][tx] = Some(piece);
                    self.squares[fy][fx] = None;
                    Ok(())
                } else {
                    Err("Invalid pawn move".into())
                }
            }
            _ => Err("Only pawn moves implemented".into()),
        }
    }

    fn parse_coord(coord: &str) -> Result<(usize, usize), String> {
        if coord.len() != 2 {
            return Err("Invalid coordinate length".into());
        }
        let bytes = coord.as_bytes();
        let file = (bytes[0] - b'a') as usize;
        let rank = (b'8' - bytes[1]) as usize; // 8->0, 1->7
        if file > 7 || rank > 7 {
            return Err("Coordinate out of bounds".into());
        }
        Ok((file, rank))
    }
}

fn main() {
    let mut board = Board::new();
    println!("Initial board:");
    board.display();

    // Example move e2 to e4
    match board.move_piece("e2", "e4") {
        Ok(_) => println!("Moved e2 to e4"),
        Err(e) => println!("Move failed: {}", e),
    }

    println!("\nBoard after move:");
    board.display();
}
