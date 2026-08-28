/**
 * WebLLM bridge for Godot JavaScriptBridge (window.shaberuLLM).
 * Loaded by the custom HTML shell before the Godot engine.
 */
(function () {
  "use strict";

  let engine = null;
  let abortFlag = false;
  let loading = false;

  function progressText(report) {
    if (!report) return "";
    if (typeof report === "string") return report;
    if (report.text) return report.text;
    if (report.progress != null) {
      return "Loading model… " + Math.round(Number(report.progress) * 100) + "%";
    }
    return JSON.stringify(report);
  }

  window.shaberuLLM = {
    async initModel(mlcModelId, onProgress, onReady, onError) {
      loading = true;
      abortFlag = false;
      try {
        if (!navigator.gpu) {
          throw new Error("WebGPU is not available in this browser");
        }
        const webllm = window.webllm;
        if (!webllm || !webllm.CreateMLCEngine) {
          throw new Error("WebLLM library not loaded");
        }
        const appConfig = {
          ...(webllm.prebuiltAppConfig || {}),
          cacheBackend: "indexeddb",
        };
        engine = await webllm.CreateMLCEngine(mlcModelId, {
          appConfig,
          initProgressCallback: (report) => {
            const p =
              report && report.progress != null ? Number(report.progress) : 0;
            if (onProgress) onProgress(p, progressText(report));
          },
        });
        loading = false;
        if (onReady) onReady(mlcModelId);
      } catch (err) {
        loading = false;
        engine = null;
        if (onError) onError(String(err && err.message ? err.message : err));
      }
    },

    async chat(payloadJson, onToken, onDone, onError) {
      abortFlag = false;
      try {
        if (!engine) throw new Error("Engine not initialized");
        const payload =
          typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
        const messages = payload.messages || [];
        const stream = payload.stream !== false;
        const genOpts = {
          messages,
          temperature:
            typeof payload.temperature === "number" ? payload.temperature : 0.6,
          top_p: typeof payload.top_p === "number" ? payload.top_p : 0.9,
          max_tokens:
            typeof payload.max_tokens === "number" ? payload.max_tokens : 256,
          frequency_penalty:
            typeof payload.frequency_penalty === "number"
              ? payload.frequency_penalty
              : 0.12,
        };
        let full = "";
        if (stream) {
          const chunks = await engine.chat.completions.create({
            ...genOpts,
            stream: true,
            stream_options: { include_usage: false },
          });
          for await (const chunk of chunks) {
            if (abortFlag) break;
            const delta =
              chunk &&
              chunk.choices &&
              chunk.choices[0] &&
              chunk.choices[0].delta
                ? chunk.choices[0].delta.content || ""
                : "";
            if (delta) {
              full += delta;
              if (onToken) onToken(delta);
            }
          }
        } else {
          const reply = await engine.chat.completions.create({
            ...genOpts,
            stream: false,
          });
          full =
            reply &&
            reply.choices &&
            reply.choices[0] &&
            reply.choices[0].message
              ? reply.choices[0].message.content || ""
              : "";
          if (onToken && full) onToken(full);
        }
        if (onDone) onDone(full);
      } catch (err) {
        if (onError) onError(String(err && err.message ? err.message : err));
      }
    },

    abort() {
      abortFlag = true;
    },

    unload() {
      engine = null;
    },

    async hasModelInCache(mlcModelId) {
      try {
        const webllm = window.webllm;
        if (webllm && webllm.hasModelInCache) {
          return await webllm.hasModelInCache(mlcModelId);
        }
      } catch (_) {}
      return false;
    },

    isLoading() {
      return loading;
    },
  };
})();
