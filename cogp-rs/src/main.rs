mod convert;
mod meta;
mod validate;
mod wkb_bbox;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "cogp", version, about = "Cloud Optimized GeoParquet Profile reference CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Convert a GeoParquet file into a COGP file
    Convert(convert::ConvertArgs),
    /// Validate that a Parquet file conforms to the COGP profile
    Validate(ValidateArgs),
}

#[derive(clap::Args)]
struct ValidateArgs {
    /// Path to the file to validate
    input: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Convert(args) => convert::run(args),
        Command::Validate(args) => validate::run(&args.input),
    }
}
