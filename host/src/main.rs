use zireh_host::{config::Config, features::sync, http};

#[tokio::main]
async fn main() {
    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("config error: {e}");
        std::process::exit(1);
    });
    let store = sync::store::Store::open(&config.sync_db).unwrap_or_else(|e| {
        eprintln!("cannot open sync database {}: {e}", config.sync_db);
        std::process::exit(1);
    });
    let app = http::base_router().merge(sync::routes::router(store));
    let listener = tokio::net::TcpListener::bind((config.bind.as_str(), config.port)).await.unwrap_or_else(|e| {
        eprintln!("cannot listen on {}:{}: {e}", config.bind, config.port);
        std::process::exit(1);
    });
    println!("sync host listening on {}:{} (stores ciphertext only)", config.bind, config.port);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
