use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "project", version, about = "A sample CLI project")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    Hello,
}
