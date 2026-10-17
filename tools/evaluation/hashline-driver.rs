// Corral fixture adapter for oh-my-pi 647f9fa5dfae227d48a9588251f1a8439811e0e2 (MIT).
// Build as a pi-edit example; this only stages edits to a disposable fixture.
use pi_edit::{
    files::FileCache, modes::hashline::HashlineEngine, ArgSnapshot, EditStore, ModeEngine,
    PathPolicy,
};
use serde::Deserialize;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    text: String,
    patch: String,
}

fn run() -> Result<String, Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    if input.len() > 2 * 1024 * 1024 {
        return Err("input too large".into());
    }
    let request: Request = serde_json::from_str(&input)?;
    if !request.patch.starts_with("[fixture.txt#{tag}]\n")
        || request.patch.lines().skip(1).any(|line| {
            !line.is_empty()
                && !line.starts_with('+')
                && !line.starts_with("PUT ")
                && !line.starts_with("CUT ")
        })
    {
        return Err("unsupported fixture patch".into());
    }
    let root = tempfile::tempdir()?;
    let path = root.path().join("fixture.txt");
    std::fs::write(&path, &request.text)?;
    let store = EditStore::new();
    let lines: Vec<u32> = (1..=request.text.lines().count() as u32).collect();
    let tag = store
        .record_file(&path, Some(&lines))
        .ok_or("fixture read failed")?;
    let mut files = FileCache::new(PathPolicy {
        cwd: root.path().to_owned(),
        home_dir: root.path().to_owned(),
        url_schemes: vec![],
        url_alias_schemes: vec![],
        plan_writable_roots: vec![],
        plan_active: false,
        block_auto_generated: false,
    });
    let args = ArgSnapshot {
        input: Some(request.patch.replace("{tag}", &tag)),
        complete: true,
        ..Default::default()
    };
    let staged = HashlineEngine {
        enforce_seen_lines: true,
    }
    .stage(&args, &mut files, &store)?;
    if staged.len() != 1 || staged[0].absolute != path || staged[0].move_to.is_some() {
        return Err("unexpected fixture target".into());
    }
    Ok(staged[0]
        .persisted
        .clone()
        .unwrap_or_else(|| request.text.clone()))
}

fn main() {
    let result = match run() {
        Ok(text) => {
            serde_json::json!({"ok":true,"sourceCommit":"647f9fa5dfae227d48a9588251f1a8439811e0e2","text":text})
        }
        Err(_) => {
            serde_json::json!({"ok":false,"sourceCommit":"647f9fa5dfae227d48a9588251f1a8439811e0e2","error":"hashline_refused"})
        }
    };
    println!("{}", result);
}
