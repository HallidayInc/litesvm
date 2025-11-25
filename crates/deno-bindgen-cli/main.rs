use std::path::PathBuf;

use structopt::StructOpt;

mod cargo;
mod dlfcn;

#[derive(Debug, StructOpt)]
#[structopt(name = "deno_bindgen_cli", about = "A CLI for deno_bindgen")]
struct Opt {
    /// Build in release mode
    #[structopt(short, long)]
    release: bool,

    #[structopt(short, long)]
    out: Option<PathBuf>,

    #[structopt(short, long)]
    lazy_init: bool,
}

fn main() -> std::io::Result<()> {
    let opt = Opt::from_args();

    let cwd = std::env::current_dir().unwrap();
    let artifact = cargo::Build::new().release(opt.release).build(&cwd)?;

    let name = cargo::metadata()?;
    println!("Initializing {name}");

    let path = PathBuf::from(artifact.path);
    #[cfg(target_os = "windows")]
    let path = path
        .strip_prefix(&cwd)
        .expect("path is not a prefix of cwd");

    unsafe { dlfcn::load_and_init(&path, opt.out, opt.lazy_init)? };

    println!("Ready {name}");
    Ok(())
}
