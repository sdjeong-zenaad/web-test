/**
 * WebLLM bridge for Godot JavaScriptBridge (window.shaberuLLM).
 * Loaded by the custom HTML shell before the Godot engine.
 */
(function () {
  "use strict";

  let engine = null;
  let abortFlag = false;
  let loading = false;

  const webgpuStatus = {
    checked: false,
    available: false,
    reason: "",
  };

  async function waitForFrames(count = 2) {
    for (let i = 0; i < count; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async function requestGpuAdapter() {
    if (!navigator.gpu) {
      return null;
    }
    let adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      adapter = await navigator.gpu.requestAdapter();
    }
    if (!adapter && navigator.gpu.requestAdapters) {
      for await (const candidate of navigator.gpu.requestAdapters()) {
        adapter = candidate;
        break;
      }
    }
    return adapter;
  }

  async function evaluateWebGPU(options = {}) {
    const force = Boolean(options.force);
    if (webgpuStatus.checked && webgpuStatus.available && !force) {
      return webgpuStatus;
    }
    if (force) {
      webgpuStatus.checked = false;
    }
    if (!navigator.gpu) {
      webgpuStatus.checked = true;
      webgpuStatus.available = false;
      webgpuStatus.reason =
        "WebGPU API not exposed in this browser";
      return webgpuStatus;
    }
    try {
      await waitForFrames(force ? 2 : 1);
      const adapter = await requestGpuAdapter();
      if (!adapter) {
        webgpuStatus.checked = true;
        webgpuStatus.available = false;
        webgpuStatus.reason =
          "No WebGPU adapter (common on Linux Chrome/Flatpak — try native Chrome or flatpak override --device=all)";
        return webgpuStatus;
      }
      webgpuStatus.checked = true;
      webgpuStatus.available = true;
      webgpuStatus.reason = "";
    } catch (err) {
      webgpuStatus.checked = true;
      webgpuStatus.available = false;
      webgpuStatus.reason = String(
        err && err.message ? err.message : err
      );
    }
    return webgpuStatus;
  }

  async function probeWebGPUWithRetries(onResult, attempts = 5) {
    let status = webgpuStatus;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
      status = await evaluateWebGPU({ force: true });
      if (status.available) {
        break;
      }
    }
    if (onResult) {
      onResult(status.available, status.reason);
    }
    return status.available;
  }

  function progressText(report) {
    if (!report) return "";
    if (typeof report === "string") return report;
    if (report.text) return report.text;
    if (report.progress != null) {
      return "Loading model… " + Math.round(Number(report.progress) * 100) + "%";
    }
    return JSON.stringify(report);
  }

  function isCacheCollisionError(err) {
    const msg = String(err && err.message ? err.message : err);
    return (
      msg.includes("ConstraintError") ||
      msg.includes("Key already exists in the object store")
    );
  }

  async function purgeModelCache(webllm, mlcModelId, appConfig) {
    if (!webllm) return;
    if (typeof webllm.deleteModelAllInfoInCache === "function") {
      await webllm.deleteModelAllInfoInCache(mlcModelId, appConfig);
      return;
    }
    if (typeof webllm.deleteModelInCache === "function") {
      await webllm.deleteModelInCache(mlcModelId, appConfig);
    }
  }

  async function createEngine(webllm, mlcModelId, appConfig, onProgress) {
    return webllm.CreateMLCEngine(mlcModelId, {
      appConfig,
      initProgressCallback: (report) => {
        const p =
          report && report.progress != null ? Number(report.progress) : 0;
        if (onProgress) onProgress(p, progressText(report));
      },
    });
  }

  window.shaberuLLM = {
    isWebGPUAvailable() {
      return webgpuStatus.checked && webgpuStatus.available;
    },

    getWebGPUUnavailableReason() {
      return webgpuStatus.reason || "";
    },

    async probeWebGPU(onResult) {
      return probeWebGPUWithRetries(onResult, 5);
    },

    async initModel(mlcModelId, onProgress, onReady, onError) {
      loading = true;
      abortFlag = false;
      try {
        const status = await evaluateWebGPU({ force: true });
        if (!status.available) {
          throw new Error(
            status.reason ||
              "WebGPU adapter unavailable — WebLLM cannot run on this browser/GPU setup"
          );
        }
        const webllm = window.webllm;
        if (!webllm || !webllm.CreateMLCEngine) {
          throw new Error("WebLLM library not loaded");
        }
        const appConfig = {
          ...(webllm.prebuiltAppConfig || {}),
          cacheBackend: "indexeddb",
        };
        try {
          engine = await createEngine(
            webllm,
            mlcModelId,
            appConfig,
            onProgress
          );
        } catch (err) {
          if (!isCacheCollisionError(err)) {
            throw err;
          }
          if (onProgress) {
            onProgress(0, "Clearing corrupted WebLLM cache…");
          }
          await purgeModelCache(webllm, mlcModelId, appConfig);
          engine = await createEngine(
            webllm,
            mlcModelId,
            appConfig,
            onProgress
          );
        }
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

    async clearModelCache(mlcModelId) {
      try {
        const webllm = window.webllm;
        if (!webllm) return false;
        const appConfig = {
          ...(webllm.prebuiltAppConfig || {}),
          cacheBackend: "indexeddb",
        };
        await purgeModelCache(webllm, mlcModelId, appConfig);
        return true;
      } catch (_) {
        return false;
      }
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
