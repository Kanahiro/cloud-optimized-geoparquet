use anyhow::Result;
use clap::{Parser, Subcommand};
use cogp::{convert, validate};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "cogp",
    version,
    about = "Cloud Optimized GeoParquet Profile reference CLI"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Convert a GeoParquet file into a COGP file
    Convert(convert::ConvertArgs),
    /// Validate a COGP file: GeoParquet with `geo.lod` metadata.
    ///
    /// A file without `geo.lod` may be valid GeoParquet but is not a COGP file.
    /// Overviews in an encoding this validator does not support are reported
    /// as not validated; they do not make the file invalid.
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
