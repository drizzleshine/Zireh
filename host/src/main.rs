use std::time::Duration;

use zireh_host::config::Config;
use zireh_host::features::relay::{self, config::RelayConfig, config::Upstream};
use zireh_host::features::sync;
use zireh_host::http;

fn fatal(message: String) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let config = Config::from_env().unwrap_or_else(|e| fatal(format!("config error: {e}")));
    let relay_config = RelayConfig::from_lookup(|k| std::env::var(k).ok()).unwrap_or_else(|e| fatal(format!("relay config error: {e}")));
    let store = sync::store::Store::open(&config.sync_db).unwrap_or_else(|e| fatal(format!("cannot open sync database {}: {e}", config.sync_db)));
    let (relay, scanner) = relay::from_config(&relay_config).unwrap_or_else(|e| fatal(format!("cannot start the relay: {e}")));

    if let Some((payments, url, birthday)) = scanner {
        tokio::spawn(payments.run_scanner(url, Duration::from_secs(15), birthday));
    }
    let offered: Vec<&str> = relay.models.iter().map(|m| m.price.model.as_str()).collect();
    let app = http::base_router().merge(sync::routes::router(store)).merge(relay::router(relay.clone()));
    let listener = tokio::net::TcpListener::bind((config.bind.as_str(), config.port)).await.unwrap_or_else(|e| fatal(format!("cannot listen on {}:{}: {e}", config.bind, config.port)));

    println!("zireh host listening on {}:{}", config.bind, config.port);
    println!("sync: ciphertext only, in {}", config.sync_db);
    match &relay_config.upstream {
        Upstream::TokenFactory { base_url, .. } => println!("upstream: Nebius Token Factory ({base_url})"),
        Upstream::LocalDev { local_model, .. } => println!("upstream: LOCAL DEV via {local_model} — not Token Factory"),
    }
    println!("models: {}", offered.join(", "));
    println!("search: {}", if relay.search.is_some() { "Tavily" } else { "disabled (no TAVILY_API_KEY)" });
    println!("payments: {}", match &relay_config.zcash { Some(z) => format!("Zcash {} (viewing key only)", z.network), None => "simulated Zcash network".into() });

    if let Err(e) = axum::serve(listener, app).await {
        fatal(format!("server error: {e}"));
    }
}
