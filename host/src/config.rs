use std::env;

/// Runtime configuration, read once from the environment.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub bind: String,
    pub sync_db: String,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        Self::from_lookup(|k| env::var(k).ok())
    }

    /// `SYNC_PORT` and `SYNC_HOST_BIND` are the TypeScript sync host's names and win when set,
    /// so existing deployments keep working.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let port = match get("SYNC_PORT").or_else(|| get("PORT")) {
            Some(p) => p.trim().parse::<u16>().map_err(|_| format!("invalid port: {p}"))?,
            None => 8788,
        };
        let bind = get("SYNC_HOST_BIND").or_else(|| get("HOST")).unwrap_or_else(|| "127.0.0.1".into());
        let sync_db = get("SYNC_DB").unwrap_or_else(|| ".zireh/sync/sync.db".into());
        Ok(Config { port, bind, sync_db })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_aliases() {
        let c = Config::from_lookup(|_| None).unwrap();
        assert_eq!((c.port, c.bind.as_str(), c.sync_db.as_str()), (8788, "127.0.0.1", ".zireh/sync/sync.db"));
        let c = Config::from_lookup(|k| match k {
            "PORT" => Some("1".into()),
            "SYNC_PORT" => Some("2".into()),
            "HOST" => Some("h".into()),
            "SYNC_HOST_BIND" => Some("0.0.0.0".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!((c.port, c.bind.as_str()), (2, "0.0.0.0"));
        assert!(Config::from_lookup(|k| (k == "PORT").then(|| "x".into())).is_err());
    }
}
