    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model())}:generateContent`;
    const r = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens() },
      }),
    });
    if (!r.ok) throw new Error(`google HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = (await r.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // Thinking models spend maxOutputTokens before emitting text — an empty
    // string here usually means LLM_MAX_TOKENS is too low, not that the model
    // had nothing to say.
    return parts.map((p) => p?.text ?? "").join(" ").trim();
