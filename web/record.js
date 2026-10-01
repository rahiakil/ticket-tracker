(function (root) {
  const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)$/;

  function recordUrl(value) {
    const text = String(value || "").trim();
    return URL_RE.test(text) ? text : "";
  }

  async function commit(options, mutate) {
    const url = recordUrl(options.recordUrl);
    if (!url) return { ok: false, message: "Add the record link first." };
    const load = options.load;
    const post = options.post;
    const newId = options.newId || (() => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let book;
      try {
        book = await load(url);
      } catch (error) {
        return { ok: false, message: failMessage(error) };
      }
      if (!book || book.schemaVersion !== 1 || !book.orders) return { ok: false, message: "Could not save—retry. The record file was not readable." };
      const changed = mutate(book);
      if (!changed.write) return { ok: true, message: changed.message, book };
      const writeId = newId();
      changed.book.lastWriteId = writeId;
      try {
        await post(url, changed.book);
      } catch {
        continue;
      }
      let confirmed;
      try {
        confirmed = await load(url);
      } catch {
        continue;
      }
      if (confirmed && confirmed.lastWriteId === writeId) return { ok: true, message: changed.message, book: confirmed };
    }
    return { ok: false, message: "Could not save—retry. The record did not confirm the save." };
  }

  function failMessage(error) {
    const reason = error && error.message;
    if (reason === "access") return "Could not save—retry. Google refused access. Set Who has access to Anyone.";
    if (reason === "timeout") return "Could not save—retry. The record link did not answer.";
    return "Could not save—retry";
  }

  function loadWithScript(url) {
    return new Promise((resolve, reject) => {
      const callback = `ttRecord_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const script = root.document.createElement("script");
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout"));
      }, 12000);
      function cleanup() {
        clearTimeout(timer);
        delete root[callback];
        script.remove();
      }
      root[callback] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("access"));
      };
      const join = url.includes("?") ? "&" : "?";
      script.src = `${url}${join}callback=${callback}&t=${Date.now()}`;
      root.document.head.append(script);
    });
  }

  function postWithForm(url, book) {
    return root.fetch(url, {
      method: "POST",
      mode: "no-cors",
      body: new URLSearchParams({ payload: JSON.stringify(book) }),
    });
  }

  root.TicketRecord = { commit, recordUrl, loadWithScript, postWithForm };
})(typeof globalThis !== "undefined" ? globalThis : this);
