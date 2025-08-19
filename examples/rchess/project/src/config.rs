use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    pub greeting: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { greeting: "Hello, world!".into() }
    }
}

impl Config {
    pub fn load(path: Option<&PathBuf>) -> Self {
        let mut cfg = Self::default();
        if let Some(p) = path {
            if p.exists() {
                let content = fs::read_to_string(p).expect("Failed to read config");
                cfg = serde_yaml::from_str(&content).expect("Failed to parse config");
            }
        }
        cfg
    }
}
