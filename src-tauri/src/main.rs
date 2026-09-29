// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `review comments` etc. run the command line instead of the app.
    if let Some(code) = review_lib::cli::run_if_command() {
        std::process::exit(code);
    }
    review_lib::run()
}
