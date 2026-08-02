    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model(),
        max_tokens: maxTokens(),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = (await r.json()) as { content?: { type?: string; text?: string }[] };
    return (data.content ?? []).map((c) => (c?.type === "text" ? (c.text ?? "") : "")).join(" ").trim();
