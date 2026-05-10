(function () {
  const API_SCHEMA_VERSION = 1;
  const LOCAL_REQUEST_HEADER = { "X-Requested-With": "latency-manager" };
  const DEBOUNCE_MS = 200;
  const DEFAULT_TTL_MS = 5000;

  const pending = new Map();
  const timers = new Map();
  const lastFired = new Map();

  // Response cache: key -> { data, timestamp }
  const cache = new Map();
  // Per-endpoint TTL overrides (in ms)
  const ttlConfig = new Map();

  function requestKey(method, path) {
    return method + " " + path;
  }

  function getTTL(path) {
    for (const [pattern, ttl] of ttlConfig) {
      if (path === pattern || (pattern instanceof RegExp && pattern.test(path))) {
        return ttl;
      }
    }
    return DEFAULT_TTL_MS;
  }

  function cacheGet(key, path) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > getTTL(path)) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  function cacheSet(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
  }

  function cacheInvalidate(pattern) {
    if (pattern) {
      for (const key of cache.keys()) {
        if (key === pattern || (pattern instanceof RegExp && pattern.test(key))) {
          cache.delete(key);
        }
      }
    } else {
      cache.clear();
    }
  }

  function mergeSignals(externalSignal, internalController) {
    if (!externalSignal) return internalController.signal;
    if (externalSignal.aborted) {
      internalController.abort(externalSignal.reason);
      return internalController.signal;
    }
    const onAbort = () => internalController.abort(externalSignal.reason);
    externalSignal.addEventListener("abort", onAbort, { once: true });
    internalController.signal.addEventListener(
      "abort",
      () => externalSignal.removeEventListener("abort", onAbort),
      { once: true }
    );
    return internalController.signal;
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    const key = requestKey(method, path);

    // POST requests are mutations: invalidate all cache
    if (method === "POST") {
      cacheInvalidate();
    }

    // For GET requests, check cache before hitting network
    if (method === "GET") {
      const cached = cacheGet(key, path);
      if (cached) {
        return { res: null, data: cached, fromCache: true };
      }
    }

    const existing = pending.get(key);
    if (existing) {
      existing.controller.abort();
    }

    const controller = new AbortController();
    const signal = mergeSignals(options.signal, controller);

    const headers = {
      ...(options.headers || {}),
    };

    const now = Date.now();
    const last = lastFired.get(key) || 0;
    const elapsed = now - last;
    const delay = elapsed >= DEBOUNCE_MS ? 0 : DEBOUNCE_MS - elapsed;

    const promise = new Promise((resolve, reject) => {
      const fire = async () => {
        timers.delete(key);
        lastFired.set(key, Date.now());
        try {
          const res = await fetch(path, {
            ...options,
            headers,
            signal,
          });
          const data = await res.json();

          if (data.api_schema_version !== API_SCHEMA_VERSION) {
            const error = new Error("Unsupported LatencyManager API schema.");
            error.response = res;
            error.payload = data;
            throw error;
          }

          // Cache successful GET responses
          if (method === "GET") {
            cacheSet(key, data);
          }

          resolve({ res, data, fromCache: false });
        } catch (err) {
          reject(err);
        } finally {
          if (pending.get(key)?.controller === controller) {
            pending.delete(key);
          }
        }
      };

      if (delay > 0) {
        const timerId = setTimeout(fire, delay);
        timers.set(key, { timerId, promise });
      } else {
        fire();
      }
    });

    pending.set(key, { controller, promise });
    return promise;
  }

  function localPost(path, options = {}) {
    return request(path, {
      ...options,
      method: "POST",
      headers: {
        ...LOCAL_REQUEST_HEADER,
        ...(options.headers || {}),
      },
    });
  }

  function setTTL(pattern, ttlMs) {
    ttlConfig.set(pattern, ttlMs);
  }

  function clearCache(pattern) {
    cacheInvalidate(pattern);
  }

  window.LatencyApi = {
    API_SCHEMA_VERSION,
    request,
    localPost,
    setTTL,
    clearCache,
  };
})();
