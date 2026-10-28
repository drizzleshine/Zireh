//! Settings come from the environment, then from a `.env` file in the working directory (or the
//! file named by `ZIREH_ENV_FILE`). A real environment variable always wins over the file.

use std::collections::HashMap;

/// `KEY=value` lines; `#` comments, blank lines and an optional `export ` prefix are ignored,
/// and one pair of surrounding quotes is removed.
pub fn parse(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return None;
            }
            let value = value.trim();
            let unquoted = [('"', '"'), ('\'', '\'')].iter().find_map(|(a, b)| value.strip_prefix(*a)?.strip_suffix(*b)).unwrap_or(value);
            Some((key.to_string(), unquoted.to_string()))
        })
        .collect()
}

/// A lookup over the environment and the `.env` file (missing file: environment only).
pub fn lookup() -> impl Fn(&str) -> Option<String> + Clone {
    let path = std::env::var("ZIREH_ENV_FILE").unwrap_or_else(|_| ".env".into());
    let file = std::sync::Arc::new(std::fs::read_to_string(&path).map(|t| parse(&t)).unwrap_or_default());
    move |key: &str| std::env::var(key).ok().or_else(|| file.get(key).cloned())
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_the_same_lines_as_scripts_dev() {
        let env = parse("# comment\nLLM_API_KEY=\"abc\"\nexport LLM_MODELS=a:0.1:0.2\n\nLLM_EXTRA_BODY={\"reasoning_effort\":\"minimal\"}\nnot a line\nEMPTY=\n");
        assert_eq!(env["LLM_API_KEY"], "abc");
        assert_eq!(env["LLM_MODELS"], "a:0.1:0.2");
        assert_eq!(env["LLM_EXTRA_BODY"], r#"{"reasoning_effort":"minimal"}"#);
        assert_eq!(env["EMPTY"], "");
        assert_eq!(env.len(), 4);
    }
}
