// Research-only CPU embedding probe. JSONL over pipes; no sockets or raw
// text/path logs.
#include "ggml-backend.h"
#include "llama.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
static double ms(Clock::time_point t) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
}
static void quiet(enum ggml_log_level, const char *, void *) {}
static void emit(const json &x) { std::cout << x.dump() << '\n' << std::flush; }
static std::vector<float> linear(const std::vector<float> &x, const json &w,
                                 const json &b) {
  std::vector<float> y(w.size());
  for (size_t i = 0; i < w.size(); i++) {
    if (w[i].size() != x.size())
      throw std::runtime_error("head_shape");
    float sum = b[i].get<float>();
    for (size_t j = 0; j < x.size(); j++)
      sum += x[j] * w[i][j].get<float>();
    y[i] = sum;
  }
  return y;
}
static std::vector<float> head(const std::vector<float> &input, const json &h) {
  const auto &w = h.at("weights");
  auto x = input;
  float mean = 0, var = 0;
  for (float value : x)
    mean += value;
  mean /= x.size();
  for (float value : x)
    var += (value - mean) * (value - mean);
  var /= x.size();
  float inverse = 1.0f / std::sqrt(var + h.at("epsilon").get<float>());
  for (size_t i = 0; i < x.size(); i++)
    x[i] = (x[i] - mean) * inverse * w.at("net.0.weight")[i].get<float>() +
           w.at("net.0.bias")[i].get<float>();
  x = linear(x, w.at("net.1.weight"), w.at("net.1.bias"));
  for (float &value : x)
    value = 0.5f * value * (1.0f + std::erf(value / std::sqrt(2.0f)));
  return linear(x, w.at("net.4.weight"), w.at("net.4.bias"));
}
int main(int argc, char **argv) {
  llama_log_set(quiet, nullptr);
  ggml_log_set(quiet, nullptr);
  try {
    if (argc != 4)
      throw std::runtime_error("startup");
    int threads = std::stoi(argv[3]);
    if (threads < 1 || threads > 6)
      throw std::runtime_error("startup");
    std::ifstream f(argv[2]);
    json h;
    f >> h;
    if (h.at("format") != 1 || h.at("dimensions") != 768 ||
        h.at("width") != 64 || h.at("activation") != "gelu_erf")
      throw std::runtime_error("startup");
    auto start = Clock::now();
    llama_backend_init();
    auto mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    ggml_backend_dev_t devices[] = {
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr};
    if (!devices[0])
      throw std::runtime_error("startup");
    mp.devices = devices;
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
        llama_model_load_from_file(argv[1], mp), llama_model_free);
    if (!model || llama_model_n_embd_out(model.get()) != 768)
      throw std::runtime_error("startup");
    auto cp = llama_context_default_params();
    cp.n_ctx = 1024;
    cp.n_batch = 1024;
    cp.n_ubatch = 1024;
    cp.n_seq_max = 1;
    cp.n_threads = threads;
    cp.n_threads_batch = threads;
    cp.embeddings = true;
    cp.pooling_type = LLAMA_POOLING_TYPE_MEAN;
    cp.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
    cp.offload_kqv = false;
    cp.op_offload = false;
    cp.no_perf = true;
    std::unique_ptr<llama_context, decltype(&llama_free)> context(
        llama_init_from_model(model.get(), cp), llama_free);
    if (!context)
      throw std::runtime_error("startup");
    auto vocab = llama_model_get_vocab(model.get());
    emit({{"type", "ready"},
          {"backend", "cpu"},
          {"dimensions", 768},
          {"loadMs", ms(start)},
          {"nBatch", 1024},
          {"nUbatch", 1024}});
    std::string line;
    int64_t last = 0;
    while (std::getline(std::cin, line)) {
      json id = nullptr;
      try {
        auto q = json::parse(line);
        id = q.at("id");
        if (!id.is_number_integer() || id.get<int64_t>() <= last)
          throw std::runtime_error("request");
        last = id.get<int64_t>();
        std::string text =
            "task: classification | query: " + q.at("text").get<std::string>();
        int budget = q.value("inputBudget", 1024);
        if (budget < 129 || budget > 1024 || text.size() > 1024 * 1024)
          throw std::runtime_error("request");
        start = Clock::now();
        int n = -llama_tokenize(vocab, text.data(), text.size(), nullptr, 0,
                                true, true);
        if (n <= 0)
          throw std::runtime_error("tokens");
        std::vector<llama_token> tokens(n);
        if (llama_tokenize(vocab, text.data(), text.size(), tokens.data(), n,
                           true, true) != n)
          throw std::runtime_error("tokens");
        if (n > budget) {
          std::vector<llama_token> clipped(tokens.begin(),
                                           tokens.begin() + 128);
          clipped.insert(clipped.end(), tokens.end() - (budget - 128),
                         tokens.end());
          tokens = std::move(clipped);
        }
        auto memory = llama_get_memory(context.get());
        if (memory)
          llama_memory_clear(memory, true);
        std::unique_ptr<llama_batch_ext, decltype(&llama_batch_ext_free)> batch(
            llama_batch_ext_init(context.get()), llama_batch_ext_free);
        for (size_t i = 0; i < tokens.size(); i++) {
          auto at = llama_batch_ext_add_token(batch.get(), 0, tokens[i]);
          llama_pos pos = i;
          if (at < 0 || !llama_batch_ext_set_pos(batch.get(), at, &pos) ||
              !llama_batch_ext_set_output_logits(batch.get(), at, true))
            throw std::runtime_error("batch");
        }
        // One full noncausal graph: never split the sequence into independent
        // prefills.
        if (llama_process(context.get(), LLAMA_PROCESS_TYPE_DECODE,
                          batch.get()) != 0)
          throw std::runtime_error("inference");
        const float *pooled = llama_get_embeddings_seq(context.get(), 0);
        if (!pooled)
          throw std::runtime_error("embedding");
        std::vector<float> embedding(pooled, pooled + 768);
        double norm = 0;
        for (float x : embedding)
          norm += double(x) * x;
        if (!std::isfinite(norm) || norm <= 0)
          throw std::runtime_error("embedding");
        for (float &x : embedding)
          x /= std::sqrt(norm);
        auto logits = head(embedding, h);
        for (float x : logits)
          if (!std::isfinite(x))
            throw std::runtime_error("head");
        if (memory)
          llama_memory_clear(memory, true);
        emit({{"type", "result"},
              {"id", id},
              {"originalTokens", n},
              {"tokens", tokens},
              {"embedding", embedding},
              {"logits", logits},
              {"prediction",
               std::max_element(logits.begin(), logits.end()) - logits.begin()},
              {"elapsedMs", ms(start)}});
      } catch (...) {
        auto memory = llama_get_memory(context.get());
        if (memory)
          llama_memory_clear(memory, true);
        emit({{"type", "error"}, {"id", id}, {"error", "request_failed"}});
      }
    }
  } catch (...) {
    emit({{"type", "error"}, {"error", "startup_failed"}});
    return 1;
  }
  return 0;
}
