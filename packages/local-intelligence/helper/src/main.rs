//! Corral local AI helper: loads the LiteRT-LM C library and one embedding model, then answers
//! embedding requests one at a time as JSON lines on stdin/stdout. It opens no network socket.
//!
//! Arguments (all required):
//!   --lib <path> --model <path> --backend <cpu|gpu> --threads <n|0> --max-input <tokens>
//!   --cache-dir <dir> --api-major <n> --api-minor <n>
//!
//! stdout lines:
//!   {"type":"ready","api":[major,minor,patch],"backend":"cpu"}
//!   {"type":"result","id":1,"embeddings":[[...]]}
//!   {"type":"error","id":1,"message":"..."}
//!   {"type":"fatal","message":"..."}   (then exit code 2)
//! stdin lines:
//!   {"id":1,"texts":["..."],"overflow":"truncate"|"chunk_average","dim":768}
//!
//! The library's handles are not thread-safe, so every call runs on the main thread.

use libloading::{Library, Symbol};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{BufRead, Write};
use std::ptr::{null, null_mut};

type Status = c_int;
const INPUT_TEXT: c_int = 0;
const OVERFLOW_CHUNK_AND_AVERAGE: c_int = 0;
const OVERFLOW_TRUNCATE: c_int = 1;
const LOG_ERROR: c_int = 3;

#[derive(Deserialize)]
struct Request {
    id: u64,
    texts: Vec<String>,
    overflow: String,
    dim: c_int,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message<'a> {
    Ready { api: [c_int; 3], backend: &'a str },
    Result { id: u64, embeddings: Vec<Vec<f32>> },
    Error { id: u64, message: String },
    Fatal { message: String },
}

fn emit(message: &Message) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // A closed stdout means the server is gone; the read loop ends on stdin EOF.
    let _ = serde_json::to_writer(&mut out, message);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
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
            self.check("embedding_response_get_size", (self.response_size)(response, &mut size))?;
            self.check("embedding_response_get_values", (self.response_values)(response, &mut values))?;
            if values.is_null() {
                return Err("embedding response has no values".into());
            }
            Ok(std::slice::from_raw_parts(values, size).to_vec())
        }
    }

    fn embed(&self, engine: *mut c_void, request: &Request) -> Result<Vec<Vec<f32>>, String> {
        let overflow = match request.overflow.as_str() {
            "truncate" => OVERFLOW_TRUNCATE,
            "chunk_average" => OVERFLOW_CHUNK_AND_AVERAGE,
            other => return Err(format!("unknown overflow strategy {other}")),
        };
        if request.texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut options = null_mut();
        let mut inputs: Vec<*mut c_void> = Vec::with_capacity(request.texts.len());
        let result = (|| unsafe {
            self.check("embedding_options_create", (self.options_create)(&mut options))?;
            self.check("set_normalize", (self.options_normalize)(options, true))?;
            self.check("set_output_size", (self.options_output_size)(options, request.dim))?;
            self.check("set_input_overflow_strategy", (self.options_overflow)(options, overflow))?;
            for text in &request.texts {
                let mut input = null_mut();
                self.check(
                    "input_data_create",
                    (self.input_create)(INPUT_TEXT, text.as_ptr().cast(), text.len(), &mut input),
                )?;
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
            let mut vectors = Vec::with_capacity(inputs.len());
            let collected = (|| {
                self.check("embedding_responses_get_size", (self.responses_size)(responses, &mut count))?;
                if count != inputs.len() {
                    return Err(format!("expected {} embeddings, got {count}", inputs.len()));
                }
                for index in 0..count {
                    let mut response = null();
                    self.check("embedding_responses_get_at", (self.responses_at)(responses, index, &mut response))?;
                    vectors.push(self.vector(response)?);
                }
                Ok(())
            })();
            (self.responses_delete)(responses);
            collected.map(|_| vectors)
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

fn arguments() -> Result<HashMap<String, String>, String> {
    let mut args = std::env::args().skip(1);
    let mut found = HashMap::new();
    while let Some(flag) = args.next() {
        let name = flag.strip_prefix("--").ok_or_else(|| format!("unexpected argument {flag}"))?;
        let value = args.next().ok_or_else(|| format!("--{name} needs a value"))?;
        found.insert(name.to_string(), value);
    }
    for name in ["lib", "model", "backend", "threads", "max-input", "cache-dir", "api-major", "api-minor"] {
        if !found.contains_key(name) {
            return Err(format!("missing --{name}"));
        }
    }
    Ok(found)
}

fn number(args: &HashMap<String, String>, name: &str) -> Result<c_int, String> {
    args[name].parse().map_err(|_| format!("--{name} must be a number"))
}

fn main() {
    if let Err(message) = run() {
        emit(&Message::Fatal { message });
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let args = arguments()?;
    let backend = args["backend"].as_str();
    if backend != "cpu" && backend != "gpu" {
        return Err(format!("unknown backend {backend}"));
    }
    let threads = number(&args, "threads")?;
    let max_input = number(&args, "max-input")?;
    let (want_major, want_minor) = (number(&args, "api-major")?, number(&args, "api-minor")?);
    let lib = unsafe { Library::new(&args["lib"]) }.map_err(|e| format!("cannot load the runtime library: {e}"))?;
    macro_rules! sym {
        ($name:literal) => {
            unsafe { lib.get(concat!($name, "\0").as_bytes()) }.map_err(|e| format!("{}: {e}", $name))?
        };
    }

    // The version function's name and signature are stable; check it before anything else.
    let get_api_version: Symbol<unsafe extern "C" fn(*mut c_int, *mut c_int, *mut c_int) -> Status> =
        sym!("litert_lm_get_api_version");
    let mut api = [0 as c_int; 3];
    if unsafe { get_api_version(&mut api[0], &mut api[1], &mut api[2]) } != 0 {
        return Err("the runtime library did not report its API version".into());
    }
    if api[0] != want_major || api[1] < want_minor {
        return Err(format!(
            "runtime library API {}.{}.{} is not compatible with {want_major}.{want_minor}",
            api[0], api[1], api[2]
        ));
    }

    let set_log_level: Symbol<unsafe extern "C" fn(c_int) -> Status> = sym!("litert_lm_set_min_log_level");
    let settings_create: Symbol<unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char, *mut *mut c_void) -> Status> =
        sym!("litert_lm_embedding_engine_settings_create");
    let settings_delete: Symbol<unsafe extern "C" fn(*mut c_void)> = sym!("litert_lm_embedding_engine_settings_delete");
    let settings_threads: Symbol<unsafe extern "C" fn(*mut c_void, c_int) -> Status> =
        sym!("litert_lm_embedding_engine_settings_set_num_threads");
    let settings_max_input: Symbol<unsafe extern "C" fn(*mut c_void, c_int) -> Status> =
        sym!("litert_lm_embedding_engine_settings_set_max_input_length");
    let settings_cache_dir: Symbol<unsafe extern "C" fn(*mut c_void, *const c_char) -> Status> =
        sym!("litert_lm_embedding_engine_settings_set_cache_dir");
    let engine_create: Symbol<unsafe extern "C" fn(*const c_void, *mut *mut c_void) -> Status> =
        sym!("litert_lm_embedding_engine_create");
    let engine_delete: Symbol<unsafe extern "C" fn(*mut c_void)> = sym!("litert_lm_embedding_engine_delete");
    let api_fns = Api {
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

    let model = CString::new(args["model"].as_str()).map_err(|e| e.to_string())?;
    let backend_name = CString::new(backend).map_err(|e| e.to_string())?;
    let cache_dir = CString::new(args["cache-dir"].as_str()).map_err(|e| e.to_string())?;
    let mut engine = null_mut();
    unsafe {
        let _ = set_log_level(LOG_ERROR);
        let mut settings = null_mut();
        api_fns.check(
            "embedding_engine_settings_create",
            settings_create(model.as_ptr(), backend_name.as_ptr(), null(), null(), &mut settings),
        )?;
        let configured = (|| {
            if threads > 0 {
                api_fns.check("set_num_threads", settings_threads(settings, threads))?;
            }
            api_fns.check("set_max_input_length", settings_max_input(settings, max_input))?;
            api_fns.check("set_cache_dir", settings_cache_dir(settings, cache_dir.as_ptr()))?;
            api_fns.check("embedding_engine_create", engine_create(settings, &mut engine))
        })();
        settings_delete(settings);
        configured?;
    }

    emit(&Message::Ready { api, backend });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("ignoring a malformed request: {error}");
                continue;
            }
        };
        match api_fns.embed(engine, &request) {
            Ok(embeddings) => emit(&Message::Result { id: request.id, embeddings }),
            Err(message) => emit(&Message::Error { id: request.id, message }),
        }
    }
    unsafe { engine_delete(engine) };
    Ok(())
}
