/**
 * HTML overlay chat UI above the Godot canvas (CJK-friendly IME).
 * Adaptive: landscape = chat on right of square viewer; portrait = chat below.
 * Soft keyboard: keep chat panel geometry; float input row above keyboard.
 * Exposes window.shaberuChat for Godot JavaScriptBridge.
 */
(function () {
  "use strict";

  const STYLE_ID = "shaberu-chat-style";
  const ROOT_ID = "shaberu-chat-overlay";
  const FLOAT_ID = "shaberu-chat-float-input";

  let root = null;
  let floatDock = null;
  let messagesEl = null;
  let inputRow = null;
  let inputEl = null;
  let sendBtn = null;
  let abortBtn = null;
  let modelSelect = null;
  let personaSelect = null;
  let oversizeCheck = null;
  let newBtn = null;
  let statusEl = null;
  let capsEl = null;
  let progressEl = null;
  let assistantLabel = "Avatar";
  let inputFocused = false;
  let layoutChat = { left: 0, top: 0, width: 320, height: 400 };

  let cbSend = null;
  let cbAbort = null;
  let cbModel = null;
  let cbPersona = null;
  let cbOversize = null;
  let cbNew = null;
  let cbFocus = null;

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
#${ROOT_ID} {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  border-radius: 0;
  background: rgba(248, 250, 252, 0.96);
  box-shadow: none;
  font-family: "Noto Sans KR", "Noto Sans JP", "Segoe UI", "Apple SD Gothic Neo",
    "Malgun Gothic", "Hiragino Sans", sans-serif;
  color: #0f172a;
  z-index: 20;
  pointer-events: auto;
}
#${ROOT_ID}.hidden { display: none; }
#${ROOT_ID} .toolbar { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
#${ROOT_ID} select { flex: 1; min-width: 0; height: 32px; }
#${ROOT_ID} .caps {
  font-size: 11px; color: #475569; line-height: 1.35; word-break: break-word; flex-shrink: 0;
}
#${ROOT_ID} .status {
  font-size: 12px; color: #334155; line-height: 1.35; word-break: break-word;
  font-weight: 600; flex-shrink: 0;
}
#${ROOT_ID} .status.download {
  color: #1d8fff;
  font-weight: 700;
}
#${ROOT_ID} progress { width: 100%; height: 10px; flex-shrink: 0; }
#${ROOT_ID} .messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: rgba(255,255,255,0.7);
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px;
  font-size: 14px;
}
#${ROOT_ID} .msg { margin-bottom: 10px; white-space: pre-wrap; word-break: break-word; }
#${ROOT_ID} .msg .who { font-weight: 700; margin-bottom: 2px; }
#${ROOT_ID} .msg .latency { color: #9aa3ad; font-weight: 400; }
#${ROOT_ID} .msg.user .who { color: #0b3d91; }
#${ROOT_ID} .msg.assistant .who { color: #14532d; }
#${ROOT_ID} .msg.system {
  margin-bottom: 8px;
  font-size: 11px;
  color: #8a9099;
  line-height: 1.35;
}
#${ROOT_ID} .msg.system .who { display: none; }
#${ROOT_ID} .msg.system .body { font-weight: 400; }
@media (hover: hover) and (pointer: fine) and (min-width: 900px) {
  #${ROOT_ID} .caps { font-size: 22px; }
  #${ROOT_ID} .status { font-size: 24px; }
  #${ROOT_ID} .messages { font-size: 28px; }
  #${ROOT_ID} .msg.system { font-size: 22px; }
  #${ROOT_ID} select, #${ROOT_ID} button, #${ROOT_ID} input, #${ROOT_ID} label.force { font-size: 28px; }
  #${ROOT_ID} select { height: 48px; }
}
#${ROOT_ID} .input-row,
#${FLOAT_ID} .input-row { display: flex; gap: 6px; flex-shrink: 0; }
#${ROOT_ID} textarea,
#${FLOAT_ID} textarea {
  flex: 1; min-height: 40px; max-height: 96px; resize: vertical;
  border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px;
  font: inherit;
}
#${ROOT_ID} button,
#${FLOAT_ID} button {
  border: 0; border-radius: 8px; padding: 8px 10px;
  background: #0f172a; color: #fff; cursor: pointer; font: inherit;
}
#${ROOT_ID} button.secondary,
#${FLOAT_ID} button.secondary { background: #64748b; }
#${ROOT_ID} label.force { font-size: 12px; display: flex; gap: 4px; align-items: center; }
#${FLOAT_ID} {
  position: fixed;
  z-index: 30;
  display: none;
  padding: 8px;
  box-sizing: border-box;
  background: rgba(248, 250, 252, 0.98);
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  pointer-events: auto;
}
#${FLOAT_ID}.visible { display: block; }
`;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let softKeyboardSupported =
    ("ontouchstart" in window && navigator.maxTouchPoints > 0) ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

  function layoutSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!softKeyboardSupported || !window.visualViewport) {
      return { w: w, h: h, kb: 0, visH: h, offsetTop: 0 };
    }
    const vv = window.visualViewport;
    const kb = Math.max(0, h - vv.height - vv.offsetTop);
    // Stable design size while keyboard is open.
    return {
      w: w,
      h: Math.max(h, vv.height + kb),
      kb: kb,
      visH: vv.height,
      offsetTop: vv.offsetTop || 0,
    };
  }

  function computeRects(size) {
    const w = Math.max(1, size.w);
    const h = Math.max(1, size.h);
    if (w >= h) {
      const side = h;
      return {
        landscape: true,
        viewer: { left: 0, top: 0, width: side, height: side },
        chat: { left: side, top: 0, width: Math.max(1, w - side), height: h },
      };
    }
    const side = w;
    return {
      landscape: false,
      viewer: { left: 0, top: 0, width: side, height: side },
      chat: { left: 0, top: side, width: w, height: Math.max(1, h - side) },
    };
  }

  function applyLayout() {
    if (!root) return;
    const size = layoutSize();
    const rects = computeRects(size);
    layoutChat = rects.chat;
    root.style.left = rects.chat.left + "px";
    root.style.top = rects.chat.top + "px";
    root.style.width = rects.chat.width + "px";
    root.style.height = rects.chat.height + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    updateFloatDock(size);
  }

  function updateFloatDock(size) {
    if (!floatDock || !inputRow) return;
    const s = size || layoutSize();
    const shouldFloat = s.kb > 40 && inputFocused;
    if (shouldFloat) {
      if (inputRow.parentElement !== floatDock) {
        floatDock.appendChild(inputRow);
      }
      floatDock.classList.add("visible");
      const pad = 8;
      const dockW = Math.max(120, layoutChat.width - pad * 2);
      const dockH = Math.max(52, inputRow.getBoundingClientRect().height || 52);
      const top = s.offsetTop + s.visH - dockH - pad;
      floatDock.style.left = layoutChat.left + pad + "px";
      floatDock.style.top = Math.max(pad, top) + "px";
      floatDock.style.width = dockW + "px";
    } else {
      floatDock.classList.remove("visible");
      if (statusEl && inputRow.parentElement !== root) {
        root.insertBefore(inputRow, statusEl);
      }
    }
  }

  function mount(onSend, onAbort, onModel, onOversize, onNew, onFocus, onPersona) {
    cbSend = onSend;
    cbAbort = onAbort;
    cbModel = onModel;
    cbOversize = onOversize;
    cbNew = onNew;
    cbFocus = onFocus;
    cbPersona = onPersona || null;

    ensureStyle();
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = el("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    root.innerHTML = "";

    floatDock = document.getElementById(FLOAT_ID);
    if (!floatDock) {
      floatDock = el("div");
      floatDock.id = FLOAT_ID;
      document.body.appendChild(floatDock);
    }
    floatDock.innerHTML = "";
    floatDock.classList.remove("visible");

    const toolbar = el("div", "toolbar");
    personaSelect = el("select");
    personaSelect.style.flex = "0 0 96px";
    modelSelect = el("select");
    oversizeCheck = null; // models stay selectable; warnings use ⚠ prefix
    newBtn = el("button", "secondary", "Reset");
    toolbar.appendChild(personaSelect);
    toolbar.appendChild(modelSelect);
    toolbar.appendChild(newBtn);

    capsEl = el("div", "caps", "Capabilities…");
    progressEl = document.createElement("progress");
    progressEl.max = 1;
    progressEl.value = 0;
    messagesEl = el("div", "messages");

    inputRow = el("div", "input-row");
    inputEl = el("textarea");
    inputEl.rows = 2;
    inputEl.placeholder = "메시지 입력… / Type a message…";
    sendBtn = el("button", null, "Send");
    abortBtn = el("button", "secondary", "Stop");
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);
    inputRow.appendChild(abortBtn);

    statusEl = el("div", "status", "Ready");

    root.appendChild(toolbar);
    root.appendChild(capsEl);
    root.appendChild(progressEl);
    root.appendChild(messagesEl);
    root.appendChild(inputRow);
    root.appendChild(statusEl);

    sendBtn.addEventListener("click", () => {
      if (cbSend) cbSend(inputEl.value);
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (cbSend) cbSend(inputEl.value);
      }
    });
    abortBtn.addEventListener("click", () => {
      if (cbAbort) cbAbort();
    });
    newBtn.addEventListener("click", () => {
      if (cbNew) cbNew();
    });
    modelSelect.addEventListener("change", () => {
      if (cbModel) cbModel(modelSelect.value);
    });
    personaSelect.addEventListener("change", () => {
      if (cbPersona) cbPersona(personaSelect.value);
    });
    inputEl.addEventListener("focus", () => {
      inputFocused = true;
      if (cbFocus) cbFocus(true);
      updateFloatDock();
    });
    inputEl.addEventListener("blur", () => {
      inputFocused = false;
      if (cbFocus) cbFocus(false);
      window.setTimeout(() => updateFloatDock(), 50);
    });

    window.addEventListener("resize", applyLayout);
    if (softKeyboardSupported && window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyLayout);
      window.visualViewport.addEventListener("scroll", applyLayout);
    }
    applyLayout();
  }

  function formatLatencyLabel(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1000) return `${Math.round(n)}ms`;
    const sec = n / 1000;
    if (sec < 10) return `${sec.toFixed(1)}s`;
    return `${Math.round(sec)}s`;
  }

  function appendMessage(role, content, latencyMs) {
    if (!messagesEl) return;
    const box = el("div", "msg " + role);
    if (role === "system") {
      box.appendChild(el("div", "body", content || ""));
    } else {
      const who =
        role === "user" ? "You" : role === "assistant" ? assistantLabel : role;
      box.appendChild(el("div", "who", who));
      const body = el("div", "body", content || "");
      if (role === "assistant") {
        const label = formatLatencyLabel(latencyMs);
        if (label) {
          body.appendChild(document.createTextNode(" "));
          body.appendChild(el("span", "latency", label));
        }
      }
      box.appendChild(body);
    }
    messagesEl.appendChild(box);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStreaming(content) {
    if (!messagesEl) return;
    let last = messagesEl.querySelector(".msg.assistant:last-child .body");
    if (!last) {
      appendMessage("assistant", content);
      return;
    }
    last.textContent = content || "";
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearMessages() {
    if (messagesEl) messagesEl.innerHTML = "";
  }

  window.shaberuChat = {
    mount,
    appendMessage,
    setStreaming,
    clearMessages,
    setInput(text) {
      if (inputEl) inputEl.value = text || "";
    },
    getInput() {
      return inputEl ? inputEl.value : "";
    },
    setInputEnabled(enabled) {
      if (inputEl) inputEl.disabled = !enabled;
      if (sendBtn) sendBtn.disabled = !enabled;
    },
    setStatus(text) {
      if (!statusEl) return;
      statusEl.classList.remove("download");
      statusEl.textContent = text || "";
    },
    setProgress(progress, message) {
      if (progressEl) progressEl.value = Math.max(0, Math.min(1, Number(progress) || 0));
      if (!message || !statusEl) return;
      if (String(message).startsWith("Downloading")) {
        statusEl.classList.add("download");
      } else {
        statusEl.classList.remove("download");
      }
      statusEl.textContent = message;
    },
    setModels(payloadJson) {
      if (!modelSelect) return;
      const payload =
        typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
      const models = payload.models || [];
      const selected = payload.selected_id || "";
      modelSelect.innerHTML = "";
      models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        const showWarn = m.recommended === false;
        opt.textContent = (showWarn ? "⚠ " : "") + (m.display_name || m.id);
        opt.disabled = false;
        opt.title = m.blocked_reason || "";
        if (m.id === selected) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    },
    setPersonas(payloadJson) {
      if (!personaSelect) return;
      const payload =
        typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
      const personas = payload.personas || [];
      const selected = payload.selected_id || "";
      personaSelect.innerHTML = "";
      personas.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.display_name || p.id;
        if (p.id === selected) opt.selected = true;
        personaSelect.appendChild(opt);
      });
    },
    setAssistantLabel(label) {
      assistantLabel = label || "Avatar";
      const nodes = messagesEl
        ? messagesEl.querySelectorAll(".msg.assistant .who")
        : [];
      nodes.forEach((n) => {
        n.textContent = assistantLabel;
      });
    },
    setCaps(text) {
      if (capsEl) capsEl.textContent = text || "";
    },
    setVisible(v) {
      if (!root) return;
      root.classList.toggle("hidden", !v);
    },
  };
})();
