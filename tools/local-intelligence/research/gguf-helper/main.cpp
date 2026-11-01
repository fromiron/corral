// Research only. No network, production registration, downloads, or prompt logs.
#include "llama.h"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
static double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
static void emit(const json & value) { std::cout << value.dump() << '\n' << std::flush; }
static void quiet_log(enum ggml_log_level, const char *, void *) {}
static json error(const json & id, const char * code) {
    return {{"type", "error"}, {"id", id}, {"error", code}};
}
static std::vector<llama_token> tokenize(const llama_vocab * vocab, const std::string & text, bool special) {
    const int count = -llama_tokenize(vocab, text.data(), text.size(), nullptr, 0, false, special);
    if (count <= 0) throw std::runtime_error("invalid_request");
    std::vector<llama_token> result(count);
    if (llama_tokenize(vocab, text.data(), text.size(), result.data(), result.size(), false, special) != count)
        throw std::runtime_error("invalid_request");
    return result;
}
static void hash_word(uint64_t & hash, uint32_t word) {
    for (int byte = 0; byte < 4; ++byte) {
        hash ^= (word >> (byte * 8)) & 0xff;
        hash *= 1099511628211ULL;
    }
}
static std::string hex_hash(uint64_t hash) {
    std::ostringstream out;
    out << std::hex << std::setw(16) << std::setfill('0') << hash;
    return out.str();
}
static std::string fingerprint(const float * logits, int count) {
    // Test diagnostic only: FNV over all first-token logits, never user text.
    uint64_t hash = 14695981039346656037ULL;
    for (int i = 0; i < count; ++i) {
        uint32_t bits;
        std::memcpy(&bits, &logits[i], sizeof(bits));
        hash_word(hash, bits);
    }
    return hex_hash(hash);
}
static std::string input_fingerprint(const std::vector<llama_token> & tokens) {
    uint64_t hash = 14695981039346656037ULL;
    for (const auto token : tokens) hash_word(hash, static_cast<uint32_t>(token));
    return hex_hash(hash);
}
static std::string trim(std::string text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}
static std::set<std::string> participants(const json & request) {
    if (!request.contains("participantIds") || !request["participantIds"].is_array() ||
        request["participantIds"].empty() || request["participantIds"].size() > 32)
        throw std::runtime_error("invalid_request");
    std::set<std::string> known;
    for (const auto & value : request["participantIds"]) {
        if (!value.is_string()) throw std::runtime_error("invalid_request");
        const auto id = value.get<std::string>();
        if (id.empty() || id.size() > 64 || id == "NONE" ||
            id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos ||
            !known.insert(id).second) throw std::runtime_error("invalid_request");
    }
    return known;
}
static std::vector<std::string> dispatch(const std::string & raw, const std::set<std::string> & known) {
    const auto text = trim(raw);
    if (text == "NONE") return {};
    if (text.empty() || text.back() == ',') throw std::runtime_error("invalid_response");
    std::istringstream stream(text);
    std::string part;
    std::vector<std::string> result;
    std::set<std::string> seen;
    while (std::getline(stream, part, ',')) {
        part = trim(part);
        if (!known.count(part) || !seen.insert(part).second) throw std::runtime_error("invalid_response");
        result.push_back(part);
    }
    return result;
}
struct ClearMemory {
    llama_context * context;
    explicit ClearMemory(llama_context * value) : context(value) {
        llama_memory_clear(llama_get_memory(context), true);
    }
    ~ClearMemory() { llama_memory_clear(llama_get_memory(context), true); }
};

int main(int argc, char ** argv) {
    llama_log_set(quiet_log, nullptr);
    ggml_log_set(quiet_log, nullptr);
    try {
        if (argc != 4 && argc != 6) throw std::runtime_error("startup_failed");
        std::string backend = "cpu";
        if (argc == 6) {
            backend = argv[5];
            if (std::string(argv[4]) != "--backend" || (backend != "cpu" && backend != "gpu"))
                throw std::runtime_error("startup_failed");
        }
        const bool gpu = backend == "gpu";
        const int threads = std::stoi(argv[2]);
        const int context_size = std::stoi(argv[3]);
        if (threads < 1 || threads > 6 || context_size < 128 || context_size > 4096)
            throw std::runtime_error("startup_failed");
        const auto started = Clock::now();
        llama_backend_init();
        auto model_params = llama_model_default_params();
        model_params.n_gpu_layers = gpu ? 999 : 0;
        // No auto fallback: the requested device must exist and initialize.
        ggml_backend_dev_t devices[] = {ggml_backend_dev_by_type(gpu ? GGML_BACKEND_DEVICE_TYPE_GPU : GGML_BACKEND_DEVICE_TYPE_CPU), nullptr};
        if (!devices[0]) throw std::runtime_error("startup_failed");
        model_params.devices = devices;
        std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
            llama_model_load_from_file(argv[1], model_params), llama_model_free);
        if (!model) throw std::runtime_error("startup_failed");
        auto context_params = llama_context_default_params();
        context_params.n_ctx = context_size;
        context_params.n_batch = 512;
        context_params.n_ubatch = 512;
        context_params.n_seq_max = 1;
        context_params.n_rs_seq = 0;
        context_params.n_threads = threads;
        context_params.n_threads_batch = threads;
        context_params.offload_kqv = gpu;
        context_params.op_offload = gpu;
        context_params.no_perf = true;
        std::unique_ptr<llama_context, decltype(&llama_free)> context(
            llama_init_from_model(model.get(), context_params), llama_free);
        if (!context) throw std::runtime_error("startup_failed");
        const auto * vocab = llama_model_get_vocab(model.get());
        const int vocab_count = llama_vocab_n_tokens(vocab);
        const std::array<std::string, 4> labels = {"low", "medium", "high", "xhigh"};
        std::array<llama_token, 4> label_tokens;
        std::array<size_t, 4> label_lengths;
        for (size_t i = 0; i < labels.size(); ++i) {
            const auto ids = tokenize(vocab, labels[i], false);
            label_tokens[i] = ids.front();
            label_lengths[i] = ids.size();
        }
        if (std::set<llama_token>(label_tokens.begin(), label_tokens.end()).size() != 4)
            throw std::runtime_error("startup_failed");
        emit({{"type", "ready"}, {"protocol", 1}, {"backend", backend}, {"threads", threads},
              {"loadMs", elapsed(started)}, {"labelTokenIds", label_tokens}, {"labelTokenLengths", label_lengths}});
        uint64_t last_id = 0;
        std::string line;
        while (std::getline(std::cin, line)) {
            json id = nullptr;
            json input_metadata = json::object();
            auto fail = [&](const char * code) {
                auto response = error(id, code);
                response.update(input_metadata);
                emit(response);
            };
            try {
                if (line.size() > 262144) throw std::runtime_error("invalid_request");
                const auto request = json::parse(line);
                if (!request.is_object() || !request.contains("id") || !request["id"].is_number_unsigned())
                    throw std::runtime_error("invalid_request");
                const auto serial = request["id"].get<uint64_t>();
                if (serial == 0 || serial > 9007199254740991ULL) throw std::runtime_error("invalid_request");
                id = serial;
                if (serial <= last_id) throw std::runtime_error("stale_id");
                last_id = serial;
                const auto op = request.at("op").get<std::string>();
                if (op != "effort" && op != "meeting") throw std::runtime_error("invalid_request");
                const auto known = op == "meeting" ? participants(request) : std::set<std::string>{};
                const auto prompt = request.at("prompt").get<std::string>();
                auto tokens = tokenize(vocab, prompt, true);
                const auto original_count = tokens.size();
                const int reserve = op == "meeting" ? 24 : 0;
                json budget = nullptr;
                if (request.contains("inputBudget")) {
                    if (!request["inputBudget"].is_number_unsigned()) throw std::runtime_error("invalid_budget");
                    const auto limit = request["inputBudget"].get<uint64_t>();
                    if (limit <= 128 || limit > static_cast<uint64_t>(context_size - reserve))
                        throw std::runtime_error("invalid_budget");
                    budget = limit;
                    if (tokens.size() > limit) {
                        std::vector<llama_token> clipped(tokens.begin(), tokens.begin() + 128);
                        clipped.insert(clipped.end(), tokens.end() - (limit - 128), tokens.end());
                        tokens = std::move(clipped);
                    }
                }
                if (tokens.size() + reserve > static_cast<size_t>(context_size))
                    throw std::runtime_error("input_too_long");
                input_metadata = {{"originalPromptTokens", original_count}, {"usedPromptTokens", tokens.size()},
                                  {"promptTokens", tokens.size()}, {"inputBudget", budget},
                                  {"inputTruncated", original_count != tokens.size()},
                                  {"inputTokenFingerprint", input_fingerprint(tokens)},
                                  {"inputTokenFingerprintAlgorithm", "fnv1a64-le-u32"}};
                const auto start = Clock::now();
                ClearMemory clear(context.get());
                std::unique_ptr<llama_batch_ext, decltype(&llama_batch_ext_free)> batch(
                    llama_batch_ext_init(context.get()), llama_batch_ext_free);
                auto decode = [&](const llama_token * data, int count, int offset) {
                    llama_batch_ext_clear(batch.get());
                    for (int i = 0; i < count; ++i) {
                        const int index = llama_batch_ext_add_token(batch.get(), 0, data[i]);
                        const llama_pos position = offset + i;
                        if (index < 0 || !llama_batch_ext_set_pos(batch.get(), index, &position))
                            throw std::runtime_error("inference_failed");
                    }
                    if (!llama_batch_ext_set_output_logits(batch.get(), count - 1, true) ||
                        llama_process(context.get(), LLAMA_PROCESS_TYPE_DECODE, batch.get()) != 0)
                        throw std::runtime_error("inference_failed");
                };
                for (size_t offset = 0; offset < tokens.size(); offset += 512)
                    decode(tokens.data() + offset, std::min<size_t>(512, tokens.size() - offset), offset);
                const auto * logits = llama_get_logits_ith(context.get(), -1);
                if (!logits) throw std::runtime_error("inference_failed");
                json result = {{"type", "result"}, {"id", id},
                               {"prefillMs", elapsed(start)}, {"firstLogitsFingerprint", fingerprint(logits, vocab_count)}};
                result.update(input_metadata);
                if (op == "effort") {
                    std::array<double, 4> selected, probabilities;
                    for (size_t i = 0; i < 4; ++i) {
                        selected[i] = logits[label_tokens[i]];
                        if (!std::isfinite(selected[i])) throw std::runtime_error("inference_failed");
                    }
                    const auto max = *std::max_element(selected.begin(), selected.end());
                    double sum = 0;
                    for (size_t i = 0; i < 4; ++i) sum += probabilities[i] = std::exp(selected[i] - max);
                    for (auto & probability : probabilities) probability /= sum;
                    result["logits"] = selected;
                    result["probabilities"] = probabilities;
                    result["level"] = labels[std::max_element(selected.begin(), selected.end()) - selected.begin()];
                } else {
                    std::string output;
                    bool ended = false;
                    int generated = 0;
                    for (; generated < 24; ++generated) {
                        const llama_token token = std::max_element(logits, logits + vocab_count) - logits;
                        if (llama_vocab_is_eog(vocab, token)) { ended = true; break; }
                        char piece[256];
                        const int size = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, false);
                        if (size < 0 || size > static_cast<int>(sizeof(piece))) throw std::runtime_error("invalid_response");
                        output.append(piece, size);
                        decode(&token, 1, tokens.size() + generated);
                        logits = llama_get_logits_ith(context.get(), -1);
                        if (!logits) throw std::runtime_error("inference_failed");
                    }
                    if (!ended) throw std::runtime_error("invalid_response");
                    result["participantIds"] = dispatch(output, known);
                    result["generatedTokens"] = generated;
                }
                result["totalMs"] = elapsed(start);
                emit(result);
            } catch (const json::exception &) {
                fail("invalid_request");
            } catch (const std::runtime_error & failure) {
                const std::string code = failure.what();
                const std::set<std::string> allowed = {"invalid_request", "invalid_budget", "stale_id", "input_too_long", "invalid_response", "inference_failed"};
                fail(allowed.count(code) ? code.c_str() : "inference_failed");
            } catch (...) {
                fail("inference_failed");
            }
        }
        return 0;
    } catch (...) {
        emit(error(nullptr, "startup_failed"));
        return 1;
    }
}
