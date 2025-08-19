mod cli;
mod config;

use clap::Parser;
use log::{info, LevelFilter};
use env_logger::Env;

fn main() {
    // Initialize logger
    let env = Env::default().filter_or("PROJECT_LOG_LEVEL", "info");
    env_logger::Builder::from_env(env).init();

    let cli = cli::Cli::parse();
    let cfg_path = std::env::var_os("PROJECT_CONFIG_PATH").map(|s| s.into());
    let cfg = config::Config::load(cfg_path.as_ref());

    match cli.command {
        Some(cli::Commands::Hello) => {
            info!("{}", cfg.greeting);
        }
        None => {
            // If no subcommand, print help
            cli::Cli::command().print_help().expect("Failed to print help");
        }
    }
}
