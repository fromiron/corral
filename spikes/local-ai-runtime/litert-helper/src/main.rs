//! Spike: a resident helper that loads the official LiteRT-LM C library (the shared library
//! shipped in the `litert-lm-api` wheel) and answers embedding requests as JSON lines on
//! stdin/stdout. No network listener. Not part of the product.
//!
//! Usage: corral-litert-helper-spike <lib> <model> <cpu|gpu> <threads|0> <max_input_tokens|0>

use libloading::{Library, Symbol};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{BufRead, Write};
use std::ptr::{null, null_mut};
use std::time::Instant;

type Status = c_int;
const TEXT: c_int = 0;
const OVERFLOW_TRUNCATE: c_int = 1;

#[derive(Deserialize)]
struct Request {
    id: u64,
    texts: Vec<String>,
    #[serde(default = "default_dim")]
    dim: c_int,
}

fn default_dim() -> c_int {
    768
}

#[derive(Serialize)]
struct Response {
    id: u64,
    #[serde(rename = "computeMs")]
    compute_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    embeddings: Option<Vec<Vec<f32>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Api<'a> {
    last_error: Symbol<'a, unsafe extern "C" fn() -> *const c_char>,
    input_create: Symbol<'a, unsafe extern "C" fn(c_int, *const c_void, usize, *mut *mut c_void) -> Status>,
    input_delete: Symbol<'a, unsafe extern "C" fn(*mut c_void)>,
    options_create: Symbol<'a, unsafe extern "C" fn(*mut *mut c_void) -> Status>,
    options_delete: Symbol<'a, unsafe extern "C" fn(*mut c_void)>,
    options_normalize: Symbol<'a, unsafe extern "C" fn(*mut c_void, bool) -> Status>,
    options_output_size: Symbol<'a, unsafe extern "C" fn(*mut c_void, c_int) -> Status>,
    options_overflow: Symbol<'a, unsafe extern "C" fn(*mut c_void, c_int) -> Status>,
    compute: Symbol<'a, unsafe extern "C" fn(*mut c_void, *const *mut c_void, usize, *const c_void, *mut *mut c_void) -> Status>,
    compute_batch: Symbol<'a, unsafe extern "C" fn(*mut c_void, *const *const *mut c_void, *const usize, usize, *const c_void, *mut *mut c_void) -> Status>,
    response_size: Symbol<'a, unsafe extern "C" fn(*const c_void, *mut usize) -> Status>,
    response_values: Symbol<'a, unsafe extern "C" fn(*const c_void, *mut *const f32) -> Status>,
    response_delete: Symbol<'a, unsafe extern "C" fn(*mut c_void)>,
    responses_size: Symbol<'a, unsafe extern "C" fn(*const c_void, *mut usize) -> Status>,
    responses_at: Symbol<'a, unsafe extern "C" fn(*const c_void, usize, *mut *const c_void) -> Status>,
    responses_delete: Symbol<'a, unsafe extern "C" fn(*mut c_void)>,
}

impl Api<'_> {
    fn check(&self, what: &str, status: Status) -> Result<(), String> {
        if status == 0 {
            return Ok(());
        }
        let message = unsafe {
            let raw = (self.last_error)();
            if raw.is_null() { String::new() } else { CStr::from_ptr(raw).to_string_lossy().into_owned() }
        };
        Err(format!("{what} failed with status {status}: {message}"))
    }

    fn vector(&self, response: *const c_void) -> Result<Vec<f32>, String> {
        let mut size = 0usize;
        let mut values: *const f32 = null();
        unsafe {
            self.check("response_get_size", (self.response_size)(response, &mut size))?;
            self.check("response_get_values", (self.response_values)(response, &mut values))?;
            Ok(std::slice::from_raw_parts(values, size).to_vec())
        }
    }

    fn embed(&self, engine: *mut c_void, texts: &[String], dim: c_int) -> Result<Vec<Vec<f32>>, String> {
        let mut options = null_mut();
        let mut inputs: Vec<*mut c_void> = Vec::with_capacity(texts.len());
        let result = (|| unsafe {
            self.check("options_create", (self.options_create)(&mut options))?;
            self.check("set_normalize", (self.options_normalize)(options, true))?;
            self.check("set_output_size", (self.options_output_size)(options, dim))?;
            self.check("set_overflow", (self.options_overflow)(options, OVERFLOW_TRUNCATE))?;
            for text in texts {
                let mut input = null_mut();
                self.check("input_data_create", (self.input_create)(TEXT, text.as_ptr().cast(), text.len(), &mut input))?;
                inputs.push(input);
            }
            if inputs.len() == 1 {
                let mut response = null_mut();
                self.check("compute_embedding", (self.compute)(engine, inputs.as_ptr(), 1, options, &mut response))?;
                let vector = self.vector(response);
                (self.response_delete)(response);
                return Ok(vec![vector?]);
            }
            let items: Vec<*const *mut c_void> = inputs.iter().map(|input| input as *const *mut c_void).collect();
            let counts = vec![1usize; inputs.len()];
            let mut responses = null_mut();
            self.check(
                "compute_embedding_batch",
                (self.compute_batch)(engine, items.as_ptr(), counts.as_ptr(), items.len(), options, &mut responses),
            )?;
            let mut count = 0usize;
            let mut out = Vec::new();
            let collected = (|| {
                self.check("responses_get_size", (self.responses_size)(responses, &mut count))?;
                for index in 0..count {
                    let mut response = null();
                    self.check("responses_get_at", (self.responses_at)(responses, index, &mut response))?;
                    out.push(self.vector(response)?);
                }
                Ok::<_, String>(())
            })();
            (self.responses_delete)(responses);
            collected.map(|_| out)
        })();
        unsafe {
            for input in inputs {
                (self.input_delete)(input);
            }
            if !options.is_null() {
                (self.options_delete)(options);
            }
        }
        result
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("fatal: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && args.len() != 7 {
        return Err("usage: <lib> <model> <cpu|gpu> <threads|0> <max_input_tokens|0> [cache_dir]".into());
    }
    let started = Instant::now();
    let lib = unsafe { Library::new(&args[1]) }.map_err(|e| e.to_string())?;
    macro_rules! sym {
        ($name:literal) => {
            unsafe { lib.get(concat!($name, "\0").as_bytes()) }.map_err(|e| format!("{}: {e}", $name))?
        };
    }
    let set_log_level: Symbol<unsafe extern "C" fn(c_int) -> Status> = sym!("litert_lm_set_min_log_level");
    let settings_create: Symbol<unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char, *mut *mut c_void) -> Status> =
        sym!("litert_lm_embedding_engine_settings_create");
    let settings_delete: Symbol<unsafe extern "C" fn(*mut c_void)> = sym!("litert_lm_embedding_engine_settings_delete");
    let settings_threads: Symbol<unsafe extern "C" fn(*mut c_void, c_int) -> Status> = sym!("litert_lm_embedding_engine_settings_set_num_threads");
    let settings_max_input: Symbol<unsafe extern "C" fn(*mut c_void, c_int) -> Status> = sym!("litert_lm_embedding_engine_settings_set_max_input_length");
    let settings_cache_dir: Symbol<unsafe extern "C" fn(*mut c_void, *const c_char) -> Status> = sym!("litert_lm_embedding_engine_settings_set_cache_dir");
    let cache_dir = args.get(6).map(|dir| CString::new(dir.as_str())).transpose().map_err(|e| e.to_string())?;
    let engine_create: Symbol<unsafe extern "C" fn(*const c_void, *mut *mut c_void) -> Status> = sym!("litert_lm_embedding_engine_create");
    let engine_delete: Symbol<unsafe extern "C" fn(*mut c_void)> = sym!("litert_lm_embedding_engine_delete");
    let api = Api {
        last_error: sym!("litert_lm_get_last_error_message"),
        input_create: sym!("litert_lm_input_data_create"),
        input_delete: sym!("litert_lm_input_data_delete"),
        options_create: sym!("litert_lm_embedding_options_create"),
        options_delete: sym!("litert_lm_embedding_options_delete"),
        options_normalize: sym!("litert_lm_embedding_options_set_normalize"),
        options_output_size: sym!("litert_lm_embedding_options_set_output_size"),
        options_overflow: sym!("litert_lm_embedding_options_set_input_overflow_strategy"),
        compute: sym!("litert_lm_embedding_engine_compute_embedding"),
        compute_batch: sym!("litert_lm_embedding_engine_compute_embedding_batch"),
        response_size: sym!("litert_lm_embedding_response_get_size"),
        response_values: sym!("litert_lm_embedding_response_get_values"),
        response_delete: sym!("litert_lm_embedding_response_delete"),
        responses_size: sym!("litert_lm_embedding_responses_get_size"),
        responses_at: sym!("litert_lm_embedding_responses_get_at"),
        responses_delete: sym!("litert_lm_embedding_responses_delete"),
    };

    let model = CString::new(args[2].as_str()).map_err(|e| e.to_string())?;
    let backend = CString::new(args[3].as_str()).map_err(|e| e.to_string())?;
    let threads: c_int = args[4].parse().map_err(|_| "threads")?;
    let max_input: c_int = args[5].parse().map_err(|_| "max_input_tokens")?;
    let mut engine = null_mut();
    unsafe {
        let _ = set_log_level(3);
        let mut settings = null_mut();
        api.check("settings_create", settings_create(model.as_ptr(), backend.as_ptr(), null(), null(), &mut settings))?;
        let configured = (|| {
            if threads > 0 {
                api.check("set_num_threads", settings_threads(settings, threads))?;
            }
            if max_input > 0 {
                api.check("set_max_input_length", settings_max_input(settings, max_input))?;
            }
            if let Some(dir) = &cache_dir {
                api.check("set_cache_dir", settings_cache_dir(settings, dir.as_ptr()))?;
            }
            api.check("engine_create", engine_create(settings, &mut engine))
        })();
        settings_delete(settings);
        configured?;
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{{\"ready\":true,\"loadMs\":{}}}", started.elapsed().as_secs_f64() * 1000.0).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;

    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("bad request: {error}");
                continue;
            }
        };
        let started = Instant::now();
        let result = api.embed(engine, &request.texts, request.dim);
        let compute_ms = started.elapsed().as_secs_f64() * 1000.0;
        let response = match result {
            Ok(embeddings) => Response { id: request.id, compute_ms, embeddings: Some(embeddings), error: None },
            Err(error) => Response { id: request.id, compute_ms, embeddings: None, error: Some(error) },
        };
        serde_json::to_writer(&mut out, &response).map_err(|e| e.to_string())?;
        out.write_all(b"\n").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    unsafe { engine_delete(engine) };
    Ok(())
}
